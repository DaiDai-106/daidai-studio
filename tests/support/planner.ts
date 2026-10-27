import { createServer } from "node:http";

export type PlannerRequest = {
  thinking?: { type: string };
  reasoning_effort?: string;
  messages: { role: string; content?: string | null; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};
export type PlannerReply = (
  | { text: string; splitAt?: number; beforeFinish?: Promise<void> }
  | { id: string; name: string; args: Record<string, unknown> }
) & { thinking?: string; beforeContent?: Promise<void> };

// A scripted model protocol peer; geometry and application execution remain real.
export async function servePlanner(plan: (request: PlannerRequest) => PlannerReply) {
  const requests: PlannerRequest[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as PlannerRequest;
      requests.push(input);
      const reply = plan(input);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      function chunk(delta: unknown, finish: string | null) {
        response.write(
          `data: ${JSON.stringify({ id: "workflow", object: "chat.completion.chunk", created: 1, model: "workflow-test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      }
      if (reply.thinking) chunk({ role: "assistant", reasoning_content: reply.thinking }, null);
      await reply.beforeContent;
      if ("text" in reply) {
        const split = reply.splitAt ?? reply.text.length;
        chunk({ role: "assistant", content: reply.text.slice(0, split) }, null);
        await reply.beforeFinish;
        if (split < reply.text.length) chunk({ content: reply.text.slice(split) }, null);
        chunk({}, "stop");
      } else {
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: reply.id,
                type: "function",
                function: { name: reply.name, arguments: JSON.stringify(reply.args) },
              },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
      }
      response.write(
        `data: ${JSON.stringify({ id: "workflow", object: "chat.completion.chunk", created: 1, model: "workflow-test", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end("Planner fixture failed.");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("No planner address");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failures,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export function turnResults(request: PlannerRequest) {
  const last = request.messages.map((message) => message.role).lastIndexOf("user");
  const tools = request.messages.slice(last + 1).filter((message) => message.role === "tool");
  return {
    count: tools.length,
    has(id: string) {
      return tools.some((tool) => tool.tool_call_id === id);
    },
    read<T>(id: string): T {
      const text = tools.find((tool) => tool.tool_call_id === id)?.content;
      if (!text) throw new Error(`Missing tool result: ${id}`);
      // Durable appends diagnostics as a separate <harness> block, outside the tool data.
      const diagnostic = text.indexOf("\n<harness>\n");
      return JSON.parse(diagnostic < 0 ? text : text.slice(0, diagnostic)) as T;
    },
  };
}
