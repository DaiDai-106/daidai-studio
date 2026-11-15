import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ApplicationEvent,
  Arguments,
  ProviderConfig,
  ProviderInfo,
  SettingsInfo,
} from "../../contracts/application.ts";
import type { Theme } from "../../contracts/desktop.ts";
import { writeJson } from "../../shared/node/write_json.ts";
import { createCredentials, type StoredProvider } from "./credentials.ts";
import { discoverModels } from "./discovery.ts";
import { createLogins } from "./login.ts";
import { createProviders, modelChoice } from "./providers.ts";

type Settings = {
  version: 1;
  providers: StoredProvider[];
  defaultModel: string;
  theme: Theme;
  desktopTheme: string;
  showThinking: boolean;
  deviceId: string;
};

/** 配置和凭据保存在 Dai 数据根目录。 */
export async function createSettingsService(options: {
  dataRoot: string;
  publish: (event: ApplicationEvent) => void;
}) {
  const agentRoot = join(options.dataRoot, "agent");
  const desktopRoot = join(options.dataRoot, "desktop");
  await Promise.all([
    mkdir(agentRoot, { recursive: true, mode: 0o700 }),
    mkdir(desktopRoot, { recursive: true, mode: 0o700 }),
  ]);
  const path = join(agentRoot, "settings.json");
  const desktopPath = join(desktopRoot, "settings.json");
  let settings: Settings;
  try {
    const text = await readFile(path, "utf8");
    const value = JSON.parse(text) as Settings;
    if (
      value.version !== 1 ||
      !Array.isArray(value.providers) ||
      typeof value.deviceId !== "string"
    )
      throw new Error("应用配置格式无效。");
    settings = { ...value, theme: "light", desktopTheme: "", showThinking: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = {
      version: 1,
      providers: [],
      defaultModel: "",
      theme: "light",
      desktopTheme: "",
      showThinking: true,
      deviceId: randomUUID(),
    };
  }

  try {
    const desktop = JSON.parse(await readFile(desktopPath, "utf8"));
    settings.theme = desktop.theme ?? "light";
    settings.desktopTheme = desktop.desktopTheme ?? "";
    settings.showThinking = desktop.showThinking ?? true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const credentials = await createCredentials(agentRoot, () => settings.providers);
  const providers = createProviders(credentials.store);
  const logins = createLogins(providers, settings.deviceId, (login) =>
    options.publish({ type: "login", login }),
  );
  const modelRuntime = await ModelRuntime.create({
    credentials: credentials.store,
    modelsPath: null,
    refreshOnCreate: false,
  });
  let registered = new Set<string>();

  function configure() {
    for (const id of registered) modelRuntime.unregisterProvider(id);
    registered = new Set();
    for (const config of settings.providers)
      if (config.enabled) {
        modelRuntime.registerNativeProvider(providers.create(config));
        registered.add(config.id);
      }
  }

  configure();
  let pending = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function commit(next: Settings, scope: "agent" | "desktop") {
    await writeJson(
      scope === "agent" ? path : desktopPath,
      scope === "agent"
        ? {
            version: 1,
            providers: next.providers,
            defaultModel: next.defaultModel,
            deviceId: next.deviceId,
          }
        : {
            version: 1,
            theme: next.theme,
            desktopTheme: next.desktopTheme,
            showThinking: next.showThinking,
          },
    );

    const reconfigure = next.providers !== settings.providers;
    settings = next;
    if (reconfigure) configure();
    options.publish({ type: "workspace" });
  }

  function defaultModel(configs: StoredProvider[], selected: string) {
    if (configs.some((p) => p.enabled && p.models.some((m) => `${p.id}:${m.id}` === selected)))
      return selected;
    const first = configs.find((p) => p.enabled && p.models.length);
    return first ? `${first.id}:${first.models[0]?.id ?? ""}` : "";
  }

  async function providerInfo(config: StoredProvider): Promise<ProviderInfo> {
    const { secretRef, ...value } = config;
    const provider = providers.create(config);
    const configured =
      config.authMethod === "none" ||
      (await credentials.has(config.id)) ||
      (config.authMethod === "environment" &&
        !!(await modelsFor(config, credentials.store).checkAuth(config.id)));
    return {
      ...value,
      configured,
      models: config.models.map((item) => {
        const model = provider.getModels().find((candidate) => candidate.id === item.id);
        return model ? modelChoice(model) : item;
      }),
    };
  }

  function modelsFor(config: ProviderConfig, store: typeof credentials.store) {
    const models = createModels({
      credentials: store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(providers.create(config));
    return models;
  }

  async function credentialFor(config: ProviderConfig, loginId?: string) {
    const previous = settings.providers.find((item) => item.id === config.id);
    const sameAuth =
      previous?.providerType === config.providerType &&
      previous.authMethod === config.authMethod &&
      previous.endpoint === config.endpoint;
    return loginId
      ? logins.credential(loginId, config)
      : sameAuth
        ? await credentials.store.read(config.id)
        : undefined;
  }

  async function listModels({ config, loginId, discover }: Arguments<"provider.models">) {
    const temporary = new InMemoryCredentialStore();
    const credential = await credentialFor(config, loginId);
    if (credential) await temporary.modify(config.id, async () => credential);
    const models = modelsFor(config, temporary);
    await models.refresh({ allowNetwork: false });
    if (discover && ["local", "compatible"].includes(config.providerType)) {
      const auth = await models.getAuth(config.id);
      return discoverModels(config.endpoint, auth?.auth.apiKey);
    }
    if (discover) {
      const result = await models.refresh({
        providers: [config.id],
        force: true,
        signal: AbortSignal.timeout(15000),
      });
      if (result.errors.size) throw new Error("模型目录读取失败，请检查认证或手动输入模型 ID。");
    }
    if (loginId) {
      const refreshed = await temporary.read(config.id);
      if (refreshed) logins.replaceCredential(loginId, refreshed);
    }
    return models.getModels(config.id).slice(0, 1000).map(modelChoice);
  }

  async function info(): Promise<SettingsInfo> {
    return {
      desktopTheme: settings.desktopTheme,
      providers: await Promise.all(settings.providers.map(providerInfo)),
      defaultModel: settings.defaultModel,
      theme: settings.theme,
      showThinking: settings.showThinking,
    };
  }

  const handlers = {
    async "provider.types"() {
      return providers.catalog();
    },
    "provider.models": listModels,
    "provider.save": ({ config, loginId }: Arguments<"provider.save">) =>
      serialize(async () => {
        if (
          !config.name.trim() ||
          !config.models.length ||
          new Set(config.models.map((m) => m.id)).size !== config.models.length
        )
          throw new Error("请填写服务名称并选择不重复的模型。");
        const previous = settings.providers.find((item) => item.id === config.id);
        if (!previous && settings.providers.length >= 100)
          throw new Error("最多可配置 100 个模型服务。");
        const catalogue = await listModels({
          config,
          ...(loginId ? { loginId } : {}),
          discover: false,
        });
        if (config.models.some((item) => !catalogue.some((known) => known.id === item.id)))
          throw new Error("请选择提供方目录中的模型。");
        const credential = await credentialFor(config, loginId);
        if (["oauth", "api_key"].includes(config.authMethod) && !credential)
          throw new Error("请先完成认证。");
        const secretRef = credential ? await credentials.stage(credential) : "";
        const stored = { ...config, secretRef };
        const configs = [...settings.providers.filter((item) => item.id !== config.id), stored];
        try {
          await commit(
            {
              ...settings,
              providers: configs,
              defaultModel: defaultModel(configs, settings.defaultModel),
            },
            "agent",
          );
        } catch (error) {
          if (secretRef) await credentials.remove(secretRef);
          throw error;
        }
        if (loginId) logins.consume(loginId);
        if (previous?.secretRef) await credentials.remove(previous.secretRef);
        return providerInfo(stored);
      }),
    "provider.remove": ({ id }: Arguments<"provider.remove">) =>
      serialize(async () => {
        const previous = settings.providers.find((item) => item.id === id);
        const configs = settings.providers.filter((item) => item.id !== id);
        await commit(
          {
            ...settings,
            providers: configs,
            defaultModel: defaultModel(configs, settings.defaultModel),
          },
          "agent",
        );
        if (previous?.secretRef) await credentials.remove(previous.secretRef);
        return null;
      }),
    "settings.update": (change: Arguments<"settings.update">) =>
      serialize(async () => {
        const { expectedDesktopTheme, defaultModel: selectedModel, ...desktop } = change;
        // 回退请求可能晚于用户的新选择；在写入队列内比较，不能由前端快照决定。
        if (expectedDesktopTheme !== undefined && settings.desktopTheme !== expectedDesktopTheme)
          return info();
        if (
          change.defaultModel &&
          defaultModel(settings.providers, change.defaultModel) !== change.defaultModel
        )
          throw new Error("请选择有效模型。");
        if (selectedModel !== undefined)
          await commit({ ...settings, defaultModel: selectedModel }, "agent");
        if (Object.keys(desktop).length) {
          try {
            await commit({ ...settings, ...desktop }, "desktop");
          } catch (error) {
            if (selectedModel !== undefined)
              throw new Error("默认模型已保存，但桌面设置保存失败。", { cause: error });
            throw error;
          }
        }
        return info();
      }),
    async "auth.start"({ providerType, method }: Arguments<"auth.start">) {
      return logins.start(providerType, method);
    },

    async "auth.answer"({ id, promptId, value }: Arguments<"auth.answer">) {
      return logins.answer(id, promptId, value);
    },

    async "auth.status"({ id }: Arguments<"auth.status">) {
      return logins.status(id);
    },

    async "auth.cancel"({ id }: Arguments<"auth.cancel">) {
      logins.cancel(id);
      return null;
    },

    async "auth.open"() {
      throw new Error("浏览器授权由桌面宿主处理。");
    },
  };
  return {
    handlers,
    info,
    modelRuntime,
    model(selection: string) {
      for (const config of settings.providers)
        if (config.enabled) {
          const choice = config.models.find((item) => `${config.id}:${item.id}` === selection);
          if (choice) return modelRuntime.getModel(config.id, choice.id);
        }
      return undefined;
    },

    async close() {
      logins.close();
      await pending;
    },
  };
}
