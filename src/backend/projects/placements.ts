import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryRecord, Harness, Storage } from "@earendil-works/pi-durable";
import {
  decodePlacementChange,
  type PlacementChange,
} from "../../../resources/mcp/alignment/contract.ts";
import { readPlacement, writePlacement } from "../../../resources/mcp/alignment/files.ts";
import type { ApplicationEvent } from "../../shared/application.ts";
import type { ImportedModel } from "../../shared/display.ts";
import type { RunContext } from "../agent/types.ts";
import { projectDataDirectory } from "../artifacts/location.ts";
import { CurrentDisplayDoc, ImportedModelDoc } from "../artifacts/store.ts";
import { ProjectDoc } from "./documents.ts";

// A committed tool result is the journal; the small project file is the shared current placement.
export function createPlacements(
  harness: Harness,
  storage: Storage,
  publish: (event: ApplicationEvent) => void,
  dataRoot: string,
) {
  let pending = Promise.resolve();
  let recoveryNeeded = false;
  async function target(change: PlacementChange) {
    const record = await harness.snapshot(ImportedModelDoc, change.importId, context);
    if (!record || record.model.sourceHash !== change.sourceHash)
      throw new Error("定位目标与保存模型不匹配。");
    const project = await harness.snapshot(ProjectDoc, record.model.projectId, context);
    if (!project) throw new Error("定位项目不存在。");
    return { model: record.model, project };
  }
  function publications(entry: EntryRecord) {
    const changes: { entryId: number; change: PlacementChange }[] = [];
    for (const message of entry.model ?? []) {
      if (
        message.role === "toolResult" &&
        !message.isError &&
        entry.byTaskId &&
        message.details &&
        typeof message.details === "object" &&
        !Array.isArray(message.details) &&
        "placement" in message.details
      ) {
        const change = decodePlacementChange(message.details.placement);
        if (change) changes.push({ entryId: Number(entry.id), change });
      }
    }
    return changes;
  }
  async function accept({ entryId, change }: ReturnType<typeof publications>[number]) {
    const { model, project } = await target(change);
    const root = await projectDataDirectory(dataRoot, project.id);
    const current = await readPlacement(root, change.importId, change.sourceHash);
    if (current.revision >= entryId) return;
    if (current.revision !== change.expectedRevision)
      throw new Error("定位版本已变化，拒绝覆盖新状态。");
    await writePlacement(root, {
      schemaVersion: 2,
      importId: change.importId,
      sourceHash: change.sourceHash,
      revision: entryId,
      translation: change.translation,
      rotation: change.rotation,
    });
    try {
      publish({ type: "display.changed", sourceId: model.sourceId, importId: model.importId });
    } catch {
      /* A notification cannot undo a committed placement. */
    }
  }
  const unsubscribe = harness.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === "entry") {
        pending = pending
          .then(async () => {
            for (const value of publications(change.value)) await accept(value);
          })
          .catch(() => {
            recoveryNeeded = true;
            console.error(
              "Placement publication failed; the committed tool result remains recoverable.",
            );
          });
      }
  });
  async function rebuildFiles() {
    let failed = false;
    const saved: ReturnType<typeof publications> = [];
    let conversations: Cursor | undefined;
    do {
      const page = await storage.scanConversations(
        { order: "ascending" },
        100,
        conversations,
        context,
      );
      for (const conversation of page.items) {
        let cursor: Cursor | undefined;
        do {
          const entries = await storage.scanEntries(
            { conversationId: conversation.id, order: "ascending" },
            100,
            cursor,
            context,
          );
          for (const entry of entries.items) saved.push(...publications(entry));
          cursor = entries.next;
        } while (cursor);
      }
      conversations = page.next;
    } while (conversations);
    // Rebuild the derived files from the successful journal in global causal order.
    const latest = new Map<string, ReturnType<typeof publications>[number]>();
    for (const value of saved.sort((a, b) => a.entryId - b.entryId)) {
      const previous = latest.get(value.change.importId);
      if ((previous?.entryId ?? 0) !== value.change.expectedRevision) {
        failed = true;
        continue;
      }
      latest.set(value.change.importId, value);
    }
    for (const { entryId, change } of latest.values()) {
      try {
        const { project } = await target(change);
        await writePlacement(await projectDataDirectory(dataRoot, project.id), {
          schemaVersion: 2,
          importId: change.importId,
          sourceHash: change.sourceHash,
          revision: entryId,
          translation: change.translation,
          rotation: change.rotation,
        });
      } catch {
        failed = true;
      }
    }
    recoveryNeeded = failed;
  }
  function recover() {
    const rebuilding = pending.then(rebuildFiles);
    pending = rebuilding.catch(() => {
      recoveryNeeded = true;
    });
    return rebuilding;
  }
  async function flush() {
    await pending;
    if (recoveryNeeded) await recover();
  }
  return {
    recover,
    flush,
    async prepare(value: unknown, run: RunContext): Promise<PlacementChange> {
      await flush();
      const change = decodePlacementChange(value);
      const sourceId = run.sourceId;
      if (!change || !sourceId) throw new Error("定位结果无效。");
      const { model, project } = await target(change);
      const currentDisplay = await harness.snapshot(CurrentDisplayDoc, sourceId, context);
      if (
        project.hidden ||
        project.id !== run.project.id ||
        model.sourceId !== sourceId ||
        currentDisplay?.importId !== model.importId
      )
        throw new Error("定位结果不属于当前项目、STEP 或显示版本。");
      const current = await readPlacement(
        await projectDataDirectory(dataRoot, project.id),
        model.importId,
        model.sourceHash,
      );
      if (current.revision !== change.expectedRevision)
        throw new Error("定位基准已过期，请重新读取当前状态。");
      return change;
    },
    async get(model: ImportedModel) {
      await flush();
      const project = await harness.snapshot(ProjectDoc, model.projectId, context);
      if (!project || project.hidden) throw new Error("项目不可访问。");
      return readPlacement(
        await projectDataDirectory(dataRoot, project.id),
        model.importId,
        model.sourceHash,
      );
    },
    async close() {
      unsubscribe();
      await pending;
    },
  };
}
export type Placements = ReturnType<typeof createPlacements>;
