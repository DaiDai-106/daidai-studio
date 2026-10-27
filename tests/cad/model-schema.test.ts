import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { TSchema } from "typebox";
import { alignmentTools } from "../../resources/mcp/alignment/contract.ts";
import { cadTools } from "../../resources/mcp/cad/contract.ts";
import { registerMcpTool } from "../../src/backend/agent/mcpTool.ts";
import { createProviders, modelChoice } from "../../src/backend/settings/providers.ts";

type WireFunction = {
  name: string;
  parameters?: TSchema;
  parametersJsonSchema?: TSchema;
};
type WireTool = WireFunction & {
  strict?: boolean;
  function?: WireFunction;
  input_schema?: TSchema;
  functionDeclarations?: WireFunction[];
};

// Capture real provider serialization before HTTP. Only dummy credentials are used.
for (const providerId of ["deepseek", "openai", "anthropic", "google"]) {
  for (const strict of [false, true]) {
    test(`${providerId} serializes CAD and Alignment tools through Pi (${strict ? "prefer strict" : "default"})`, {
      timeout: 10000,
    }, async () => {
      const native = builtinProviders().find((provider) => provider.id === providerId);
      assert.ok(native);
      const nativeModel = native
        .getModels()
        .find((model) => (providerId === "google" ? model.id.startsWith("gemini-3") : true));
      assert.ok(nativeModel);
      const credentials = new InMemoryCredentialStore();
      const id = `schema-test-${providerId}`;
      await credentials.modify(id, async () => ({ type: "api_key", key: "test-only" }));
      const providers = createProviders(credentials);
      providers.replace([
        {
          id,
          name: providerId,
          providerType: providerId,
          authMethod: "api_key",
          endpoint: nativeModel.baseUrl,
          enabled: true,
          persistCredentials: false,
          models: [modelChoice(nativeModel)],
        },
      ]);
      const model = providers.models.getModel(id, nativeModel.id);
      assert.ok(model);
      const tools = [...cadTools, ...alignmentTools].map((tool) => ({
        ...registerMcpTool({
          name: tool.name,
          serverName: "cad-mcp",
          tool,
          target() {
            assert.fail("Schema capture must not execute a tool");
          },
          async invoke() {
            assert.fail("Schema capture must not execute a tool");
          },
        }),
        ...(strict
          ? { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } }
          : {}),
      }));
      let captured: unknown;
      let networkRequests = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        networkRequests++;
        throw new Error("Network is forbidden in schema tests");
      };
      try {
        await providers.models.completeSimple(
          model,
          {
            messages: [{ role: "user", content: "Schema test", timestamp: 1 }],
            tools,
          },
          {
            transport: "sse",
            maxRetries: 0,
            signal: AbortSignal.timeout(5000),
            onPayload(payload) {
              captured = payload;
              throw new Error("Schema captured; stop before HTTP");
            },
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.equal(networkRequests, 0);
      assert.ok(captured, "Pi must build a request containing the tool definitions");
      const request = captured as { tools?: WireTool[]; config?: { tools?: WireTool[] } };
      const wireTools = request.tools ?? request.config?.tools;
      assert.ok(wireTools);
      // Pi may also add protocol helpers, such as Anthropic's deferred-tool placeholder.
      const functions = wireTools
        .flatMap((tool) => tool.functionDeclarations ?? [tool.function ?? tool])
        .filter((tool) => tool.name.startsWith("cad_") || tool.name.startsWith("alignment_"));
      assert.equal(functions.length, 16);
      for (const tool of tools) {
        const fn = functions.find((item) => item.name === tool.name) as WireTool | undefined;
        assert.ok(fn, tool.name);
        const schema = fn.parameters ?? fn.parametersJsonSchema ?? fn.input_schema;
        assert.ok(schema, tool.name);
        if (providerId === "anthropic") {
          // Pi decides strict support per tool and owns the input_schema root.
          const expected = fn.strict ? makeStrictJsonSchema(tool.parameters) : tool.parameters;
          const actual = schema as Record<string, unknown>;
          assert.equal(actual.type, "object");
          assert.deepEqual(actual.properties, expected.properties, tool.name);
          assert.deepEqual(actual.required ?? [], expected.required ?? [], tool.name);
          continue;
        }
        assert.deepEqual(
          schema,
          strict ? makeStrictJsonSchema(tool.parameters) : tool.parameters,
          tool.name,
        );
      }
    });
  }
}
