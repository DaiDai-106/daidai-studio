import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type {
  ApplicationEvent,
  ConversationInfo,
  ConversationView,
  WorkspaceInfo,
} from "../../../src/contracts/application.ts";
import type { ApplicationBridge } from "../../../src/contracts/bridge.ts";
import { createApplicationClient } from "../../../src/renderer/app/logic/application_client.ts";

const tick = () => new Promise<void>((done) => setImmediate(done));
const conversation = (id = "a", title = id): ConversationInfo => ({
  id,
  title,
  projectId: "p",
  createdAt: 1,
  mode: "coding",
  modelId: "",
  draft: "",
  archived: false,
  interrupted: false,
});
const workspace = (): WorkspaceInfo => ({
  settings: { providers: [], theme: "light", defaultModel: "", showThinking: true },
  projects: [{ id: "p", name: "P", path: "/tmp", mode: "coding", available: true }],
  conversations: [conversation()],
  nextCursor: "older",
  dataRoot: "/tmp",
  busyConversationIds: [],
  shellApproval: null,
  extensionUiRequests: [],
});
const view = (id = "a", sequence = 0, historyKey = "branch"): ConversationView => ({
  conversationId: id,
  streamId: "stream",
  sequence,
  historyKey,
  messages: [],
  history: { start: 0, markers: [] },
  partial: "",
  busy: true,
  error: "",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
  },
  latestResponse: null,
  respondingModel: null,
  activeTools: [],
});

async function fixture(t: TestContext) {
  let receive!: (event: ApplicationEvent) => void;
  const mock = {
    current: workspace(),
    read: async (_cursor?: string): Promise<WorkspaceInfo> => mock.current,
    update: async (change: Parameters<ApplicationBridge["updateConversation"]>[0]) => {
      const updated = { ...conversation(change.id), ...change };
      mock.current = { ...mock.current, conversations: [updated] };
      return updated;
    },
    watch: async (id: string) => view(id),
  };
  const api = {
    getWorkspace: (cursor?: string) => mock.read(cursor),
    updateConversation: (change: Parameters<ApplicationBridge["updateConversation"]>[0]) =>
      mock.update(change),
    deleteConversation: async () => {},
    watchConversation: (id: string) => mock.watch(id),
    subscribe: (listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
  } as unknown as ApplicationBridge;
  const client = createApplicationClient(api);
  const disconnect = client.connect();
  t.after(disconnect);
  await tick();
  return { client, mock, disconnect, emit: (event: ApplicationEvent) => receive(event) };
}

test("修改按顺序提交；旧快照在修改完成后到达也不能回退标题和草稿", async (t) => {
  const { client, mock } = await fixture(t);
  const stale = Promise.withResolvers<WorkspaceInfo>();
  let reads = 0;
  mock.read = async () => (++reads === 1 ? stale.promise : mock.current);
  const refresh = client.refresh();
  await tick();
  const first = Promise.withResolvers<ConversationInfo>();
  const calls: string[] = [];
  mock.update = async (change) => {
    calls.push(change.title ?? "");
    const result =
      change.title === "first" ? await first.promise : { ...conversation(), ...change };
    mock.current = { ...mock.current, conversations: [result] };
    return result;
  };
  const a = client.updateConversation({ id: "a", title: "first" });
  const b = client.updateConversation({ id: "a", title: "second", draft: "new draft" });
  await tick();
  assert.deepEqual(calls, ["first"]);
  first.resolve(conversation("a", "first"));
  await Promise.all([a, b]);
  stale.resolve(workspace());
  await refresh;
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(client.getSnapshot().workspace?.conversations[0]?.title, "second");
  assert.equal(client.getSnapshot().workspace?.conversations[0]?.draft, "new draft");
  assert.equal(reads, 2);
});

test("审批和扩展事件使旧快照失效；初始快照建立前的事件也可恢复", async (t) => {
  const { client, mock, emit } = await fixture(t);
  const stale = Promise.withResolvers<WorkspaceInfo>();
  let reads = 0;
  mock.read = async () => (++reads === 1 ? stale.promise : mock.current);
  const pending = client.refresh();
  await tick();
  const request = {
    requestId: "r",
    conversationId: "a",
    kind: "confirm" as const,
    title: "Approve",
    message: "Continue?",
  };
  mock.current = { ...mock.current, extensionUiRequests: [request] };
  emit({ type: "extension.ui.request", request });
  await tick();
  stale.resolve(workspace());
  await pending;
  assert.equal(client.getSnapshot().workspace?.extensionUiRequests?.[0]?.requestId, "r");
  mock.current = { ...mock.current, extensionUiRequests: [] };
  emit({ type: "extension.ui.dismissed", requestId: "r", conversationId: "a" });
  await tick();
  assert.deepEqual(client.getSnapshot().workspace?.extensionUiRequests, []);
});

test("删除墓碑阻止迟到的修改和快照复活会话", async (t) => {
  const { client, mock, emit } = await fixture(t);
  const updating = Promise.withResolvers<ConversationInfo>();
  mock.update = () => updating.promise;
  const pending = client.updateConversation({ id: "a", title: "late" });
  await tick();
  emit({ type: "conversationDeleted", id: "a" });
  updating.resolve(conversation("a", "late"));
  await pending;
  await client.refresh(); // 故意返回删除前的服务端快照。
  assert.deepEqual(client.getSnapshot().workspace?.conversations, []);
});

test("重复分页共用请求；刷新或局部修改后迟到的旧页被丢弃", async (t) => {
  const { client, mock } = await fixture(t);
  const page = Promise.withResolvers<WorkspaceInfo>();
  let pages = 0;
  mock.read = async (cursor) => {
    if (cursor) {
      ++pages;
      return page.promise;
    }
    return mock.current;
  };
  const a = client.loadMore();
  const b = client.loadMore();
  assert.equal(a, b);
  await tick();
  assert.equal(pages, 1);
  await client.updateConversation({ id: "a", title: "new" });
  page.resolve({
    ...workspace(),
    conversations: [conversation("a", "old"), conversation("b")],
    nextCursor: null,
  });
  assert.equal(await a, undefined);
  assert.equal(client.getSnapshot().workspace?.conversations[0]?.title, "new");
  mock.read = async () => ({
    ...workspace(),
    conversations: [conversation("b")],
    nextCursor: null,
  });
  await client.loadMore();
  assert.deepEqual(
    client.getSnapshot().workspace?.conversations.map((item) => item.id),
    ["b", "a"],
  );
});

test("流式帧复用历史数组，拒绝乱序、不同分支及不同会话的更新", async (t) => {
  const { client, emit } = await fixture(t);
  await client.activate("a");
  const initial = view("a", 1);
  initial.messages = [{ id: "m", role: "user", text: "history", failed: false }];
  emit({ type: "conversation", view: initial });
  const {
    messages: _messages,
    history: _history,
    ...progress
  } = {
    ...initial,
    sequence: 3,
    partial: "latest",
  };
  emit({ type: "conversation.progress", view: progress });
  assert.equal(client.getSnapshot().view?.messages, initial.messages);
  emit({ type: "conversation", view: { ...initial, sequence: 2 } });
  emit({ type: "conversation.progress", view: { ...progress, sequence: 4, historyKey: "other" } });
  emit({ type: "conversation.progress", view: { ...progress, sequence: 5, conversationId: "b" } });
  assert.equal(client.getSnapshot().view?.sequence, 3);
  assert.equal(client.getSnapshot().view?.partial, "latest");
  emit({
    type: "conversation",
    view: { ...initial, sequence: 6, historyKey: "other", busy: false, partial: "" },
  });
  assert.equal(client.getSnapshot().view?.busy, false);
});

test("A→B→A 时第一次 A 的 watch 响应不覆盖最后一次激活", async (t) => {
  const { client, mock } = await fixture(t);
  const old = Promise.withResolvers<ConversationView>();
  let first = true;
  mock.watch = (id) => {
    if (first) {
      first = false;
      return old.promise;
    }
    return Promise.resolve(view(id, 2));
  };
  const pending = client.activate("a");
  await client.activate("b");
  await client.activate("a");
  old.resolve({ ...view("a", 99), partial: "stale" });
  await pending;
  assert.equal(client.getSnapshot().view?.sequence, 2);
});

test("断开并重新连接后，旧快照不能覆盖新连接的数据", async () => {
  const old = Promise.withResolvers<WorkspaceInfo>();
  let reads = 0;
  const api = {
    getWorkspace: () =>
      ++reads === 1
        ? old.promise
        : Promise.resolve({ ...workspace(), conversations: [conversation("b")] }),
    subscribe: () => () => {},
  } as unknown as ApplicationBridge;
  const client = createApplicationClient(api);
  const disconnect = client.connect();
  await tick();
  disconnect();
  const cleanup = client.connect();
  try {
    await tick();
    old.resolve(workspace());
    await tick();
    assert.equal(client.getSnapshot().workspace?.conversations[0]?.id, "b");
  } finally {
    cleanup();
  }
});

test("初始快照返回前收到审批，不被迟到的空审批快照覆盖", async () => {
  let receive!: (event: ApplicationEvent) => void;
  const initial = Promise.withResolvers<WorkspaceInfo>();
  const approval = {
    id: "approval",
    conversationId: "a",
    command: "pwd",
    cwd: "/tmp",
    shell: "bash",
  };
  let reads = 0;
  const api = {
    getWorkspace: () =>
      ++reads === 1
        ? initial.promise
        : Promise.resolve({ ...workspace(), shellApproval: approval }),
    subscribe: (callback: typeof receive) => {
      receive = callback;
      return () => {};
    },
  } as unknown as ApplicationBridge;
  const client = createApplicationClient(api);
  const disconnect = client.connect();
  try {
    await tick();
    receive({ type: "shell.approval", approval });
    await tick();
    initial.resolve(workspace());
    await tick();
    assert.equal(client.getSnapshot().workspace?.shellApproval?.id, "approval");
  } finally {
    disconnect();
  }
});

test("已切走的 watch 失败不污染当前会话", async (t) => {
  const { client, mock } = await fixture(t);
  const old = Promise.withResolvers<ConversationView>();
  mock.watch = (id) => (id === "a" ? old.promise : Promise.resolve(view(id)));
  const pending = client.run(() => client.activate("a"));
  await client.activate("b");
  old.reject(new Error("old failure"));
  await pending;
  assert.equal(client.getSnapshot().view?.conversationId, "b");
  assert.equal(client.getSnapshot().error, "");
});

test("切换失败时保留原会话在等待期间收到的最终回复", async (t) => {
  const { client, mock, emit } = await fixture(t);
  await client.activate("a");
  const previous = client.getSnapshot().view;
  const target = Promise.withResolvers<ConversationView>();
  mock.watch = () => target.promise;
  const pending = assert.rejects(client.activate("b"), /cannot open/);
  assert.equal(client.getSnapshot().view, previous);
  const completed: ConversationView = {
    ...view("a", 2),
    busy: false,
    messages: [{ id: "reply", role: "assistant", text: "完成", failed: false }],
  };
  emit({ type: "conversation", view: completed });
  target.reject(new Error("cannot open"));
  await pending;
  assert.equal(client.getSnapshot().view, completed);
  mock.watch = async () => view("c");
  await assert.rejects(client.activate("b"), /与当前选择不一致/);
  assert.equal(client.getSnapshot().view, completed);
});

test("切换成功时，以目标会话先收到的新事件为准", async (t) => {
  const { client, mock, emit } = await fixture(t);
  await client.activate("a");
  const target = Promise.withResolvers<ConversationView>();
  mock.watch = () => target.promise;
  const pending = client.activate("b");
  emit({ type: "conversation", view: view("b", 4) });
  const { messages: _messages, ...progress } = { ...view("b", 5), partial: "新的回复" };
  emit({ type: "conversation.progress", view: progress });
  assert.equal(client.getSnapshot().view?.conversationId, "a");
  target.resolve(view("b", 3));
  await pending;
  assert.equal(client.getSnapshot().view?.conversationId, "b");
  assert.equal(client.getSnapshot().view?.partial, "新的回复");
});

test("刷新替换游标后，旧分页响应不能追加记录或修改新游标", async (t) => {
  const { client, mock } = await fixture(t);
  const oldPage = Promise.withResolvers<WorkspaceInfo>();
  mock.read = async (cursor) =>
    cursor ? oldPage.promise : { ...workspace(), nextCursor: "new cursor" };
  const pending = client.loadMore();
  await tick();
  await client.refresh();
  oldPage.resolve({ ...workspace(), conversations: [conversation("obsolete")], nextCursor: null });
  assert.equal(await pending, undefined);
  assert.equal(client.getSnapshot().workspace?.nextCursor, "new cursor");
  assert.equal(
    client.getSnapshot().workspace?.conversations.some((item) => item.id === "obsolete"),
    false,
  );
});

for (const invalidation of ["refresh", "write", "disconnect"] as const) {
  test(`${invalidation} 后过期分页的失败不再显示到当前界面`, async (t) => {
    const { client, mock, disconnect } = await fixture(t);
    const page = Promise.withResolvers<WorkspaceInfo>();
    mock.read = async (cursor) => (cursor ? page.promise : mock.current);
    const pending = client.run(() => client.loadMore());
    await tick();
    if (invalidation === "refresh") await client.refresh();
    else if (invalidation === "write") await client.updateConversation({ id: "a", title: "new" });
    else disconnect();
    page.reject(new Error("obsolete failure"));
    await pending;
    assert.equal(client.getSnapshot().error, "");
  });
}

test("当前分页失败仍报告错误，之后可重新读取同一页", async (t) => {
  const { client, mock } = await fixture(t);
  mock.read = async () => {
    throw new Error("current failure");
  };
  await client.run(() => client.loadMore());
  assert.equal(client.getSnapshot().error, "current failure");
  mock.read = async () => ({
    ...workspace(),
    conversations: [conversation("b")],
    nextCursor: null,
  });
  await client.run(() => client.loadMore());
  assert.equal(client.getSnapshot().error, "");
  assert.equal(client.getSnapshot().workspace?.nextCursor, null);
});
