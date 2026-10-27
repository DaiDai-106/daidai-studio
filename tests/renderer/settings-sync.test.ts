import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { ApplicationState } from "../../src/renderer/application/useApplication.ts";
import { useSettings } from "../../src/renderer/settings/useSettings.ts";
import type { McpServer, Skill } from "../../src/renderer/types.ts";
import type { SkillConfig } from "../../src/shared/capabilities.ts";

function Fixture({
  application,
  receive,
}: {
  application: ApplicationState;
  receive: (settings: ReturnType<typeof useSettings>) => void;
}) {
  receive(useSettings(application));
  return null;
}

function fixture(toggleFails = false, initialSkills: SkillConfig[] = []) {
  const calls: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  const application = {
    workspace: {
      settings: { disabledCapabilities: [], mcpServers: [], skills: initialSkills, providers: [] },
      builtins: {
        servers: [{ id: "builtin.cad", name: "CAD", modes: ["scene"] }],
        skills: [],
      },
    },
    api: {
      setCapabilityEnabled: async () => {
        calls.push("toggle");
        if (toggleFails) throw new Error("toggle failed");
      },
      saveMcp: async () => {
        calls.push("save MCP");
      },
      removeMcp: async () => {
        calls.push("remove MCP");
      },
      saveSkill: async () => {
        calls.push("save skill");
      },
      removeSkill: async () => {
        calls.push("remove skill");
      },
    },
    refresh: async () => {
      calls.push("refresh");
    },
    run: (action: () => Promise<unknown>) => {
      pending = action().catch((error) => {
        failure = error;
      });
      return pending;
    },
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
  return { settings, calls, wait: () => pending, failure: () => failure };
}

const server: McpServer = {
  id: "custom",
  name: "Example",
  builtin: false,
  enabled: true,
  scope: { kind: "global" },
  modes: ["scene"],
  transport: "stdio",
  target: "node",
  args: [],
  timeout: 30,
  checked: false,
};
const skill: Skill = {
  id: "skill",
  name: "Skill",
  builtin: false,
  enabled: true,
  scope: { kind: "global" },
  modes: ["scene"],
  description: "Example",
  body: "Do work",
};

test("capability synchronization refreshes once for builtin and custom changes", async () => {
  const subject = fixture();
  const builtin = subject.settings.servers[0];
  assert.ok(builtin);
  subject.settings.setServers([{ ...builtin, enabled: false }, server]);
  await subject.wait();
  assert.deepEqual(subject.calls, ["toggle", "save MCP", "refresh"]);
  assert.equal(subject.failure(), undefined);
  const skills = fixture();
  skills.settings.setSkills([skill]);
  await skills.wait();
  assert.deepEqual(skills.calls, ["save skill", "refresh"]);
});

test("a failed builtin switch does not hide an independently saved configuration", async () => {
  const subject = fixture(true);
  const builtin = subject.settings.servers[0];
  assert.ok(builtin);
  subject.settings.setServers([{ ...builtin, enabled: false }, server]);
  await subject.wait();
  assert.deepEqual(subject.calls, ["toggle", "save MCP", "refresh"]);
  assert.match(String(subject.failure()), /toggle failed/);
});

test("unchanged capabilities do nothing and removed skills are deleted", async () => {
  const { builtin: _builtin, ...saved } = skill;
  const subject = fixture(false, [saved]);
  subject.settings.setSkills(subject.settings.skills);
  await subject.wait();
  assert.deepEqual(subject.calls, []);
  subject.settings.setSkills([]);
  await subject.wait();
  assert.deepEqual(subject.calls, ["remove skill", "refresh"]);
});
