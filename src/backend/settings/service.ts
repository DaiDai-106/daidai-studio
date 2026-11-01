import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { createPackageMcpCredentials } from "../extensions/packageMcpCredentials.ts";
import { createCredentials, type StoredProvider } from "./credentials.ts";
import { discoverModels } from "./discovery.ts";
import { createLogins } from "./login.ts";
import { createProviders, modelChoice } from "./providers.ts";

type Settings = {
  version: 1;
  providers: StoredProvider[];
  defaultModel: string;
  theme: Theme;
  showThinking: boolean;
  deviceId: string;
};

/** 配置和凭据保存在 Dai 数据根目录。 */
export async function createSettingsService(options: {
  dataRoot: string;
  publish: (event: ApplicationEvent) => void;
}) {
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
  const path = join(options.dataRoot, "settings.json");
  async function writeSettings(value: Settings) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
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
    settings = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = {
      version: 1,
      providers: [],
      defaultModel: "",
      theme: "light",
      showThinking: true,
      deviceId: randomUUID(),
    };
  }

  const credentials = await createCredentials(options.dataRoot, () => settings.providers);
  const packageMcpCredentials = await createPackageMcpCredentials({
    read: () => credentials.readApplicationSecret("dai:package-mcp-oauth:v1"),
    write: (value) => credentials.writeApplicationSecret("dai:package-mcp-oauth:v1", value),
  });
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

  async function commit(next: Settings, reconfigure = true) {
    await writeSettings(next);

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

  async function listModels({ config, loginId, discover }: Arguments<"provider.models">) {
    const temporary = new InMemoryCredentialStore();
    const previous = settings.providers.find((item) => item.id === config.id);
    const sameAuth =
      previous?.providerType === config.providerType &&
      previous.authMethod === config.authMethod &&
      previous.endpoint === config.endpoint;
    const credential = loginId
      ? logins.credential(loginId, config)
      : sameAuth
        ? await credentials.store.read(config.id)
        : undefined;
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
        const sameAuth =
          previous?.providerType === config.providerType &&
          previous.authMethod === config.authMethod &&
          previous.endpoint === config.endpoint;
        const credential = loginId
          ? logins.credential(loginId, config)
          : sameAuth
            ? await credentials.store.read(config.id)
            : undefined;
        if (["oauth", "api_key"].includes(config.authMethod) && !credential)
          throw new Error("请先完成认证。");
        const secretRef = credential ? await credentials.stage(credential) : "";
        const stored = { ...config, secretRef };
        const configs = [...settings.providers.filter((item) => item.id !== config.id), stored];
        try {
          await commit({
            ...settings,
            providers: configs,
            defaultModel: defaultModel(configs, settings.defaultModel),
          });
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
        await commit({
          ...settings,
          providers: configs,
          defaultModel: defaultModel(configs, settings.defaultModel),
        });
        if (previous?.secretRef) await credentials.remove(previous.secretRef);
        return null;
      }),
    "settings.update": (change: Arguments<"settings.update">) =>
      serialize(async () => {
        if (
          change.defaultModel &&
          defaultModel(settings.providers, change.defaultModel) !== change.defaultModel
        )
          throw new Error("请选择有效模型。");
        await commit({ ...settings, ...change }, false);
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
    packageMcpCredentials,
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
      await packageMcpCredentials.flush();
    },
  };
}
