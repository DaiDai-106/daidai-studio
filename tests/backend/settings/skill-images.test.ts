import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSettings } from "../../../src/backend/settings/handlers.ts";

test("discarding an uploaded skill image cannot remove a saved attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-skill-image-cleanup-"));
  const vault = { available: false, read: async () => "{}", write: async () => {} };
  const storage = await openNodeSqliteStorage(join(root, "app.sqlite"));
  let harness: Harness;
  const settings = await createSettings(
    vault,
    () => harness,
    () => {},
    join(root, "images"),
  );
  harness = await Harness.open(
    storage,
    { models: settings.providers.models, registry: createRegistry() },
    context,
  );
  const logins = await settings.initialize();
  const handlers = settings.requests({
    idle() {},
    logins,
    projects: {
      async visible() {
        throw new Error("unexpected project");
      },
    },
    async releaseBuiltin() {},
  });
  try {
    const image = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
    const saved = await handlers["skill.image.add"]({ id: "skill", name: "saved", image });
    const discarded = await handlers["skill.image.add"]({ id: "skill", name: "discarded", image });
    await handlers["skill.save"]({
      config: {
        id: "skill",
        name: "技能",
        description: "描述",
        body: "内容",
        enabled: true,
        scope: { kind: "global" },
        modes: ["scene"],
        images: [saved],
      },
    });

    await assert.rejects(handlers["skill.image.remove"]({ id: "skill", path: saved.path }));
    await handlers["skill.image.remove"]({ id: "skill", path: discarded.path });
    assert.equal(
      (await handlers["skill.image.read"]({ id: "skill", path: saved.path })).data,
      image.data,
    );
    await assert.rejects(handlers["skill.image.read"]({ id: "skill", path: discarded.path }));
  } finally {
    logins.close();
    await harness.close(context);
    await rm(root, { recursive: true, force: true });
  }
});
