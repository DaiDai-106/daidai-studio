import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  distanceParameters,
  jointDraftParameters,
  sceneTransform,
  sceneTransformParameters,
} from "../../../src/backend/agent/scene_parameters.ts";
import { createProviders, modelChoice } from "../../../src/backend/settings/providers.ts";

test("位姿参数严格检查长度和有限数值", () => {
  assert.throws(() => sceneTransform([1, 2], [0, 0, 0, 1]), /三个/);
  assert.throws(() => sceneTransform([1, 2, 3], [0, 0, 0, Number.NaN]), /有限/);
  assert.deepEqual(sceneTransform([1, 2, 3], [0, 0, 0, 1]), {
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
  });
});

for (const providerId of ["deepseek", "openai", "anthropic", "google"]) {
  for (const strict of [false, true]) {
    test(`${providerId} ${strict ? "strict" : "default"} accepts homogeneous scene and joint arrays`, {
      timeout: 10_000,
    }, async () => {
      const native = builtinProviders().find((provider) => provider.id === providerId);
      const model = native
        ?.getModels()
        .find((item) => (providerId === "google" ? item.id.startsWith("gemini-3") : true));
      assert.ok(native && model);
      const credentials = new InMemoryCredentialStore();
      const id = `scene-schema-${providerId}`;
      await credentials.modify(id, async () => ({ type: "api_key", key: "test-only" }));
      const providers = createProviders(credentials);
      providers.replace([
        {
          id,
          name: providerId,
          providerType: providerId,
          authMethod: "api_key",
          endpoint: model.baseUrl,
          enabled: true,

          models: [modelChoice(model)],
        },
      ]);
      const selected = providers.models.getModel(id, model.id);
      assert.ok(selected);
      const registered = [
        {
          name: "scene_set_transform",
          description: "Set object transform",
          parameters: sceneTransformParameters,
        },
        {
          name: "scene_create_joint_draft",
          description: "Create a draft joint",
          parameters: jointDraftParameters,
        },
        {
          name: "scene_measure_distance",
          description: "Measure distance between project objects",
          parameters: distanceParameters,
        },
      ].map((tool) => ({
        ...tool,
        ...(strict
          ? { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } }
          : {}),
      }));
      let payload: unknown;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("Schema test must not access network");
      };
      try {
        await providers.models.completeSimple(
          selected,
          { messages: [{ role: "user", content: "test", timestamp: 1 }], tools: registered },
          {
            transport: "sse",
            maxRetries: 0,
            signal: AbortSignal.timeout(5000),
            onPayload(value) {
              payload = value;
              throw new Error("captured");
            },
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.ok(payload);
      type WireFunction = {
        name?: string;
        parameters?: unknown;
        parametersJsonSchema?: unknown;
        input_schema?: unknown;
      };
      type WireTool = WireFunction & {
        function?: WireFunction;
        functionDeclarations?: WireFunction[];
      };
      const request = payload as { tools?: WireTool[]; config?: { tools?: WireTool[] } };
      const tools = request.tools ?? request.config?.tools ?? [];
      const entries = tools.flatMap(
        (entry) => entry.functionDeclarations ?? [entry.function ?? entry],
      );
      function assertHomogeneous(value: unknown) {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) assertHomogeneous(item);
          return;
        }
        for (const [key, item] of Object.entries(value)) {
          if (key === "items")
            assert.equal(Array.isArray(item), false, "array items must be a single schema");
          assertHomogeneous(item);
        }
      }
      for (const tool of registered) {
        const found = entries.find((entry) => entry.name === tool.name) as
          | { parameters?: unknown; parametersJsonSchema?: unknown; input_schema?: unknown }
          | undefined;
        assert.ok(found);
        const schema = found.parameters ?? found.parametersJsonSchema ?? found.input_schema;
        assert.ok(schema);
        assertHomogeneous(schema);
        if (tool.name === "scene_measure_distance") {
          const properties = (schema as { properties?: Record<string, unknown> }).properties;
          assert.ok(properties);
          assert.equal(properties.path, undefined);
          assert.equal(properties.source, undefined);
        }
      }
    });
  }
}
