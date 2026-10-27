import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  defineDocFamily,
  type EntryRecord,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { ApplicationEvent } from "../../shared/application.ts";
import { type ImportedModel, ImportedModelRefSchema } from "../../shared/display.ts";
import { scanJournalEntries } from "../journal.ts";
import { ProjectDoc, StepSourceDoc } from "../projects/documents.ts";
import { artifactDirectory, localFile } from "./files.ts";
import { projectDataDirectory } from "./location.ts";
import { prepareDisplayArtifact, readPreparedDisplay } from "./prepare.ts";
import type { CurrentDisplayRecord, ImportedModelRecord } from "./types.ts";

export const ImportedModelDoc = defineDocFamily<ImportedModelRecord, ImportedModelRecord>({
  kind: "app.importedModel",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
});
export const CurrentDisplayDoc = defineDocFamily<CurrentDisplayRecord, null>({
  kind: "app.currentDisplay",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ importId: "", entryId: 0 }),
});
export function createArtifacts(
  harness: Harness,
  storage: Storage,
  publish: (event: ApplicationEvent) => void,
  dataRoot: string,
) {
  let pending = Promise.resolve();
  let recoveryNeeded = false;
  async function accept(entry: EntryRecord) {
    for (const message of entry.model ?? []) {
      if (
        message.role !== "toolResult" ||
        message.isError ||
        !entry.byTaskId ||
        !message.details ||
        typeof message.details !== "object" ||
        Array.isArray(message.details) ||
        !("display" in message.details) ||
        !Value.Check(ImportedModelRefSchema, message.details.display)
      )
        continue;
      const ref = message.details.display;
      const source = await harness.snapshot(StepSourceDoc, ref.sourceId, context);
      if (!source) continue;
      const project = await harness.snapshot(ProjectDoc, source.projectId, context);
      if (!project) continue;
      const existing = await harness.snapshot(ImportedModelDoc, ref.importId, context);
      const record =
        existing ??
        (await readPreparedDisplay(await projectDataDirectory(dataRoot, project.id), ref.importId));
      if (
        record.model.projectId !== project.id ||
        record.model.sourceId !== source.id ||
        record.model.sourceHash !== ref.sourceHash
      )
        throw new Error("显示引用与项目来源不匹配。");
      const model: ImportedModel = existing?.model ?? {
        ...record.model,
        producerTaskId: String(entry.byTaskId),
        producerEntryId: String(entry.id),
      };
      const changed = await harness.commit(async (tx) => {
        await tx.doc(ImportedModelDoc, ref.importId, { model, files: [...record.files] });
        const current = await tx.doc(CurrentDisplayDoc, source.id, null);
        if (current.entryId >= Number(model.producerEntryId)) return false;
        current.importId = ref.importId;
        current.entryId = Number(model.producerEntryId);
        return true;
      }, context);
      if (changed) {
        try {
          publish({ type: "display.changed", sourceId: source.id, importId: ref.importId });
        } catch {
          /* Notification failure cannot undo a committed successful import. */
        }
      }
    }
  }
  const unsubscribe = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== "entry") continue;
      pending = pending
        .then(() => accept(change.value))
        .catch(() => {
          recoveryNeeded = true;
          console.error("Display indexing failed; the saved tool result remains recoverable.");
        });
    }
  });
  async function recover() {
    await pending;
    let failed = false;
    for await (const entry of scanJournalEntries(storage)) {
      try {
        await accept(entry);
      } catch {
        failed = true;
        console.error("A saved display could not be recovered; other imports remain available.");
      }
    }
    recoveryNeeded = failed;
  }
  return {
    recover,
    async flush() {
      await pending;
      if (recoveryNeeded) await recover();
    },
    directory: (projectId: string) => projectDataDirectory(dataRoot, projectId),
    async prepare(
      value: unknown,
      scope: Parameters<typeof prepareDisplayArtifact>[1],
      run: Parameters<typeof prepareDisplayArtifact>[2],
      signal: AbortSignal,
    ) {
      return prepareDisplayArtifact(
        value,
        scope,
        run,
        signal,
        await projectDataDirectory(dataRoot, run.project.id),
      );
    },
    async get(sourceId: string) {
      await pending;
      if (recoveryNeeded) await recover();
      const current = await harness.snapshot(CurrentDisplayDoc, sourceId, context);
      return current?.importId
        ? ((await harness.snapshot(ImportedModelDoc, current.importId, context))?.model ?? null)
        : null;
    },
    async resource(importId: string, resourceId: string) {
      if (!/^[0-9a-f]{64}$/.test(importId) || !/^[0-9a-f]{64}$/.test(resourceId))
        throw new Error("资源身份无效。");
      const record = await harness.snapshot(ImportedModelDoc, importId, context);
      if (!record) throw new Error("显示产物不存在。");
      const project = await harness.snapshot(ProjectDoc, record.model.projectId, context);
      const resource = record.files.find((file) => file.id === resourceId);
      if (!project || project.hidden || !resource) throw new Error("显示资源未授权。");
      const root = await artifactDirectory(await projectDataDirectory(dataRoot, project.id));
      const path = await localFile(root, join(root, importId, resource.file), resource.byteLength);
      return { path, mediaType: resource.mediaType, byteLength: resource.byteLength };
    },
    async close() {
      unsubscribe();
      await pending;
    },
  };
}
export type Artifacts = ReturnType<typeof createArtifacts>;
