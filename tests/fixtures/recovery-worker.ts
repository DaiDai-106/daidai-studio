import { openRuntime } from "../../src/backend/runtime.ts";

const root = process.argv[2];
const endpoint = process.argv[3];
if (!root || !endpoint) throw new Error("Missing isolated test arguments");
const runtime = await openRuntime(
  root,
  {
    available: false,
    read: async () => "{}",
    write: async () => {
      throw new Error("Unexpected credential write");
    },
  },
  () => {},
);
await runtime.request("provider.save", {
  config: {
    id: "recovery-test",
    name: "Recovery test",
    providerType: "local",
    endpoint,
    enabled: true,
    authMethod: "none",
    persistCredentials: false,
    models: [{ id: "test", name: "test", context: 8192, output: 1024, reasoning: "标准" }],
  },
});
const project = await runtime.request("project.open", { path: root });
const conversation = await runtime.request("conversation.create", { projectId: project.id });
await runtime.request("conversation.send", {
  id: conversation.id,
  requestId: "crash-test",
  text: "Interrupted input",
});
process.send?.({ conversationId: conversation.id });
