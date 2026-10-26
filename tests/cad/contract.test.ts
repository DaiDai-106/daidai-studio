import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCall } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Value } from "typebox/value";
import {
  type CadToolName,
  CadTransformSchema,
  cadInputs,
  cadTools,
  validateCadInput,
} from "../../resources/mcp/cad/contract.ts";

test("all 12 public CAD input schemas stay in the common model tool subset", () => {
  const keywords = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "description",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
  ]);
  function check(value: unknown, path: string) {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), path);
    const schema = value as Record<string, unknown>;
    assert.equal(typeof schema.type, "string", `${path} must declare its type`);
    for (const key of Object.keys(schema))
      assert.ok(keywords.has(key), `${path}.${key} needs an explicit compatibility review`);
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false, path);
      for (const [name, property] of Object.entries(schema.properties ?? {}))
        check(property, `${path}.${name}`);
    }
    if (schema.type === "array") {
      assert.ok(schema.items && !Array.isArray(schema.items), `${path}.items must be a schema`);
      check(schema.items, `${path}.items`);
    }
  }
  assert.equal(cadTools.length, 12);
  for (const tool of cadTools) {
    check(tool.inputSchema, tool.name);
    assert.doesNotThrow(() => makeStrictJsonSchema(tool.inputSchema), tool.name);
  }
});

test("CAD transforms still require three coordinates and four quaternion components", () => {
  const transform = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  assert.ok(Value.Check(CadTransformSchema, transform));
  for (const key of ["translation", "rotation", "scale"] as const) {
    for (const value of [[], transform[key].slice(1), [...transform[key], 0], ["x", 0, 0]])
      assert.equal(Value.Check(CadTransformSchema, { ...transform, [key]: value }), false);
  }
});

test("Pi normalizes strict-mode optional nulls before CAD input validation", () => {
  const document = { serverInstanceId: "server", id: "document" };
  const placement = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const cases: [CadToolName, ToolCall["arguments"], ToolCall["arguments"]][] = [
    [
      "cad_import_step",
      { path: "/project/part.step", options: null },
      { path: "/project/part.step" },
    ],
    [
      "cad_import_step",
      { path: "/project/part.step", options: { sourceUnitOverride: null } },
      { path: "/project/part.step", options: {} },
    ],
    [
      "cad_get_structure",
      {
        document,
        mode: "all",
        parentObjectId: null,
        nameContains: null,
        cursor: null,
        limit: null,
      },
      { document, mode: "all" },
    ],
    [
      "cad_list_geometry_features",
      {
        document,
        objectId: "part",
        topologyRef: null,
        types: ["vertex"],
        cursor: null,
        limit: null,
      },
      { document, objectId: "part", types: ["vertex"] },
    ],
    [
      "cad_measure_distance",
      {
        document,
        first: { objectId: "a", placement },
        second: { objectId: "b", placement },
        limit: null,
      },
      { document, first: { objectId: "a", placement }, second: { objectId: "b", placement } },
    ],
  ];
  for (const [name, input, expected] of cases) {
    const args = validateToolArguments(
      { name, description: "CAD", parameters: cadInputs[name] },
      { type: "toolCall", id: "call", name, arguments: input },
    );
    assert.deepEqual(args, expected, name);
    assert.doesNotThrow(() => validateCadInput(name, args), name);
  }
  assert.throws(() => validateCadInput("cad_get_structure", { document, mode: null }));
  assert.throws(() => validateCadInput("cad_get_job", { job: { ...document, id: null } }));
});
