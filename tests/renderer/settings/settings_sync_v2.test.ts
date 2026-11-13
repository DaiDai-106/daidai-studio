import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { ApplicationState } from "../../../src/renderer/app/logic/use_application.ts";
import { useSettings } from "../../../src/renderer/features/settings/logic/use_settings.ts";

function Fixture({
  application,
  receive,
}: {
  application: ApplicationState;
  receive: (value: ReturnType<typeof useSettings>) => void;
}) {
  receive(useSettings(application));
  return null;
}

test("AI and appearance settings use the application bridge and refresh providers", async () => {
  const changes: unknown[] = [];
  let refreshes = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const application = {
    workspace: {
      settings: { providers: [], theme: "dark", showThinking: false, defaultModel: "model-a" },
    },
    api: {
      updateSettings: async (change: unknown) => {
        changes.push(change);
      },
    },
    run: (action: () => Promise<unknown>) => {
      pending = action();
      return pending;
    },
    refresh: async () => {
      refreshes++;
    },
    report: () => {},
  } as unknown as ApplicationState;
  let settings: ReturnType<typeof useSettings> | undefined;
  renderToString(
    createElement(Fixture, {
      application,
      receive: (value) => {
        settings = value;
      },
    }),
  );
  assert.ok(settings);
  assert.equal(settings.theme, "dark");
  assert.equal(settings.showThinking, false);
  assert.equal(settings.defaultModel, "model-a");
  assert.deepEqual(settings.models, []);
  settings.setTheme("light");
  await pending;
  settings.setShowThinking(true);
  await pending;
  settings.setDefaultModel("model-b");
  await pending;
  settings.updateProviders();
  await Promise.resolve();
  assert.deepEqual(changes, [
    { theme: "light" },
    { showThinking: true },
    { defaultModel: "model-b" },
  ]);
  assert.equal(refreshes, 1);
});
