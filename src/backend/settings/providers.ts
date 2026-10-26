import {
  type CredentialStore,
  createModels,
  createProvider,
  defaultProviderAuthContext,
  envApiKeyAuth,
  type Model,
  type ModelsStore,
  type Provider,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelChoice, ProviderConfig, ProviderTypeInfo } from "../../shared/application.ts";

export function modelChoice(model: Model<import("@earendil-works/pi-ai").Api>): ModelChoice {
  return {
    id: model.id,
    name: model.name,
    context: model.contextWindow,
    output: model.maxTokens,
    reasoning: model.reasoning ? "支持推理" : "标准",
  };
}
export function validateEndpoint(value: string) {
  if (!value) return;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址必须是无账号、查询参数和片段的 HTTP/HTTPS 地址。");
}
export function createProviders(credentials: CredentialStore, modelsStore?: ModelsStore) {
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  const models = createModels({
    credentials,
    ...(modelsStore ? { modelsStore } : {}),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  function base(config: ProviderConfig): Provider {
    if (config.providerType === "compatible" || config.providerType === "local") {
      if (!config.endpoint) throw new Error("请填写服务地址。");
      const api = openAICompletionsApi();
      return createProvider({
        id: config.id,
        name: config.name,
        baseUrl: config.endpoint,
        auth: { apiKey: envApiKeyAuth("API Key", []) },
        models: config.models.map((model) => ({
          id: model.id,
          name: model.name,
          api: "openai-completions" as const,
          provider: config.id,
          baseUrl: config.endpoint,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.context,
          maxTokens: model.output,
        })),
        api,
      });
    }
    const provider = builtinProviders().find((item) => item.id === config.providerType);
    if (!provider) throw new Error("当前 pi-ai 不提供此服务。");
    return provider;
  }
  function create(config: ProviderConfig): Provider {
    validateEndpoint(config.endpoint);
    const provider = base(config);
    if (config.authMethod === "oauth" && config.endpoint && config.endpoint !== provider.baseUrl)
      throw new Error("账号授权服务使用提供方的固定地址，不能自定义转发端点。");
    const auth: ProviderAuth = {};
    if (config.authMethod === "oauth" && provider.auth.oauth) auth.oauth = provider.auth.oauth;
    else if (config.authMethod === "none") {
      if (config.providerType !== "local") throw new Error("只有本地服务可选择无需认证。");
      auth.apiKey = { name: "无需认证", resolve: async () => ({ auth: { apiKey: "local" } }) };
    } else if (
      (config.authMethod === "api_key" || config.authMethod === "environment") &&
      provider.auth.apiKey
    ) {
      const apiKey = provider.auth.apiKey;
      auth.apiKey =
        config.authMethod === "environment"
          ? {
              ...apiKey,
              resolve: (input) => apiKey.resolve({ ...input, ctx: defaultProviderAuthContext() }),
              check: async (input) =>
                apiKey.check
                  ? apiKey.check({ ...input, ctx: defaultProviderAuthContext() })
                  : (await apiKey.resolve({ ...input, ctx: defaultProviderAuthContext() }))
                    ? { type: "api_key", source: "系统环境" }
                    : undefined,
            }
          : apiKey;
    } else throw new Error("此提供方不支持所选认证方式。");
    const catalog = () => {
      const native = [...provider.getModels()];
      return native.map((model) => {
        const choice = config.models.find((item) => item.id === model.id);
        return {
          ...model,
          provider: config.id,
          ...(choice ? { contextWindow: choice.context, maxTokens: choice.output } : {}),
          ...(config.endpoint ? { baseUrl: config.endpoint } : {}),
        };
      });
    };
    return {
      ...provider,
      id: config.id,
      name: config.name,
      ...(config.endpoint ? { baseUrl: config.endpoint } : {}),
      auth,
      getModels: catalog,
      getAllModels: catalog,
    };
  }
  function authDefinition(providerType: string): ProviderAuth {
    if (["compatible", "local"].includes(providerType))
      return { apiKey: envApiKeyAuth("API Key", []) };
    const provider = builtins.get(providerType);
    if (!provider) throw new Error("当前 pi-ai 不提供此服务。");
    return provider.auth;
  }
  function catalog(): ProviderTypeInfo[] {
    return [...builtins.values()]
      .map<ProviderTypeInfo>((provider) => ({
        id: provider.id,
        name: provider.name,
        endpoint: provider.baseUrl ?? "",
        methods: [
          ...(provider.auth.apiKey?.login
            ? [{ id: "api_key" as const, name: provider.auth.apiKey.name }]
            : []),
          ...(provider.auth.oauth
            ? [
                {
                  id: "oauth" as const,
                  name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
                },
              ]
            : []),
          ...(provider.auth.apiKey
            ? [{ id: "environment" as const, name: "使用当前系统环境认证" }]
            : []),
        ],
      }))
      .concat([
        {
          id: "compatible",
          name: "自定义 OpenAI Compatible",
          endpoint: "",
          methods: [{ id: "api_key", name: "API Key" }],
        },
        {
          id: "local",
          name: "本地 OpenAI Compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          methods: [
            { id: "none", name: "无需认证" },
            { id: "api_key", name: "API Key" },
          ],
        },
      ]);
  }
  return {
    models,
    base,
    create,
    catalog,
    authDefinition,
    replace(configs: readonly ProviderConfig[]) {
      models.clearProviders();
      for (const config of configs) if (config.enabled) models.setProvider(create(config));
    },
  };
}
export type Providers = ReturnType<typeof createProviders>;
