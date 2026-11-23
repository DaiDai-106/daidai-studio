import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderInfo } from "../../../src/contracts/application.ts";
import { availableModels } from "../../../src/renderer/features/settings/logic/models.ts";

test("模型选择排除失效和停用型号，保留原配置与有效型号元数据", () => {
  const provider: ProviderInfo = {
    id: "test",
    name: "Test",
    providerType: "qwen-token-plan",
    authMethod: "api_key",
    endpoint: "",
    enabled: true,
    configured: true,
    unavailableModels: ["retired"],
    models: ["valid", "retired"].map((id) => ({
      id,
      name: id,
      context: 4096,
      output: 1024,
      reasoning: "标准",
      thinkingLevels: ["off", "high"],
      supportsImages: true,
    })),
  };
  const before = structuredClone(provider);
  assert.deepEqual(availableModels([provider]), [
    { ...provider.models[0], id: "test:valid", name: "valid · Test" },
  ]);
  assert.deepEqual(availableModels([{ ...provider, enabled: false }]), []);
  assert.deepEqual(availableModels([{ ...provider, unavailableModels: ["valid", "retired"] }]), []);
  const { unavailableModels: _, ...withoutUnavailable } = provider;
  assert.equal(availableModels([withoutUnavailable]).length, 2);
  assert.deepEqual(provider, before);
});
