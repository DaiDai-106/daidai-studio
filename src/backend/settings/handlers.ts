import type { Draft } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import {
  addSkillImage,
  readSkillImage,
  removeSkillImages,
} from "../../../resources/mcp/scene-profiles/images.ts";
import type {
  ApplicationEvent,
  Arguments,
  ProviderConfig,
  ProviderInfo,
  SettingsInfo,
} from "../../shared/application.ts";
import { modeSkillIds } from "../../shared/capabilities.ts";
import type { Projects } from "../projects/handlers.ts";
import type { Handlers } from "../types.ts";
import { createCatalogStore } from "./catalog.ts";
import { createCredentials, type StoredProvider, type VaultPort } from "./credentials.ts";
import { discoverModels } from "./discovery.ts";
import { SettingsDoc, type SettingsRecord } from "./documents.ts";
import { createLogins } from "./login.ts";
import { createProviders, modelChoice } from "./providers.ts";

// Models exist before Harness.open; persistent settings load after crash recovery.
export async function createSettings(
  vault: VaultPort,
  getHarness: () => Harness,
  publish: (event: ApplicationEvent) => void,
  imagesRoot: string,
) {
  let settings: SettingsRecord | undefined;
  const changed = () => publish({ type: "workspace" });
  const credentials = await createCredentials(
    vault,
    () => settings?.providers ?? [],
    () =>
      (settings?.mcpServers ?? []).flatMap((server) =>
        server.secretRef ? [server.secretRef] : [],
      ),
  );
  const catalogStore = createCatalogStore(getHarness);
  const providers = createProviders(credentials.store, catalogStore);
  function read(): SettingsRecord {
    if (!settings) throw new Error("无法读取应用配置。");
    return settings;
  }
  async function initialize() {
    const harness = getHarness();
    await harness.commit(async (tx) => {
      await tx.doc(SettingsDoc);
    }, context);
    settings = await harness.snapshot(SettingsDoc, context);
    if (!settings) throw new Error("无法读取应用配置。");
    await credentials.prune();
    providers.replace(settings.providers);
    await providers.models.refresh({ allowNetwork: false });
    return createLogins(providers, settings.deviceId, (login) => publish({ type: "login", login }));
  }
  async function info(): Promise<SettingsInfo> {
    const value = read();
    return {
      providers: await Promise.all(value.providers.map(providerInfo)),
      defaultModel: value.defaultModel,
      theme: value.theme,
      showThinking: value.showThinking ?? true,
      disabledCapabilities: (value.disabledCapabilities ?? []).filter(
        (id) => !modeSkillIds.has(id),
      ),
      skills: value.skills ?? [],
      mcpServers: (value.mcpServers ?? []).map(({ secretRef: _secretRef, ...server }) => server),
    };
  }
  async function update(change: (draft: Draft<SettingsRecord>) => void, reconfigure = true) {
    const harness = getHarness();
    await harness.commit(async (tx) => change(await tx.doc(SettingsDoc)), context);
    settings = await harness.snapshot(SettingsDoc, context);
    if (!settings) throw new Error("无法读取配置。");
    if (reconfigure) {
      providers.replace(settings.providers);
      await providers.models.refresh({ allowNetwork: false });
    }
    changed();
  }
  async function providerInfo(config: StoredProvider): Promise<ProviderInfo> {
    const { secretRef, ...publicConfig } = config;
    const provider = providers.models.getProvider(config.id) ?? providers.create(config);
    const authenticated =
      config.authMethod === "none" ||
      (await credentials.has(config.id)) ||
      (config.authMethod === "environment" &&
        !!(await createModelsFor(config).checkAuth(config.id)));
    return {
      ...publicConfig,
      configured: authenticated,
      temporary: credentials.temporary(secretRef),
      models: config.models.map((choice) => {
        const model = provider.getModels().find((item) => item.id === choice.id);
        return model ? modelChoice(model) : choice;
      }),
    };
  }
  function createModelsFor(config: ProviderConfig) {
    const models = createModels({
      credentials: credentials.store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    models.setProvider(providers.create(config));
    return models;
  }
  function requests({
    idle,
    logins,
    projects,
    releaseBuiltin,
  }: {
    idle(): void;
    logins: ReturnType<typeof createLogins>;
    projects: Pick<Projects, "visible">;
    releaseBuiltin(id: string): Promise<void>;
  }) {
    async function listModels({ config, loginId, discover }: Arguments<"provider.models">) {
      const temporary = new InMemoryCredentialStore();
      const previous = read().providers.find((item) => item.id === config.id);
      const credential = loginId
        ? logins.credential(loginId, config)
        : previous?.providerType === config.providerType &&
            previous.endpoint === config.endpoint &&
            previous.authMethod === config.authMethod
          ? await credentials.store.read(config.id)
          : undefined;
      if (credential) await temporary.modify(config.id, async () => credential);
      const models = createModels({
        credentials: !loginId && credential ? credentials.store : temporary,
        modelsStore: catalogStore,
        authContext: { env: async () => undefined, fileExists: async () => false },
      });
      models.setProvider(providers.create(config));
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
    const handlers: Handlers<
      | "provider.types"
      | "provider.models"
      | "provider.save"
      | "provider.remove"
      | "settings.update"
      | "capability.setEnabled"
      | "auth.start"
      | "auth.answer"
      | "auth.status"
      | "auth.cancel"
      | "auth.open"
      | "skill.save"
      | "skill.image.add"
      | "skill.image.read"
      | "skill.image.remove"
      | "skill.remove"
    > = {
      async "provider.types"() {
        return providers.catalog();
      },
      async "provider.models"(args) {
        return listModels(args);
      },
      async "provider.save"({ config, loginId }) {
        idle();
        if (
          !config.name.trim() ||
          !config.models.length ||
          new Set(config.models.map((model) => model.id)).size !== config.models.length
        )
          throw new Error("请填写服务名称并选择不重复的模型。");
        const catalogue = await listModels({
          config,
          ...(loginId ? { loginId } : {}),
          discover: false,
        });
        if (config.models.some((model) => !catalogue.some((known) => known.id === model.id)))
          throw new Error("请选择提供方目录中的模型。自定义模型 ID 请使用兼容服务。");
        const previous = read().providers.find((item) => item.id === config.id);
        if (!previous && read().providers.length >= 100)
          throw new Error("最多可配置 100 个模型服务。");
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
        const secretRef = credential
          ? await credentials.stage(credential, config.persistCredentials)
          : "";
        const stored = { ...config, secretRef };
        await update((draft) => {
          draft.providers = [...draft.providers.filter((item) => item.id !== config.id), stored];
          if (
            !draft.providers.some(
              (provider) =>
                provider.enabled &&
                provider.models.some(
                  (model) => `${provider.id}:${model.id}` === draft.defaultModel,
                ),
            )
          ) {
            const next = draft.providers.find(
              (provider) => provider.enabled && provider.models.length,
            );
            draft.defaultModel = next ? `${next.id}:${next.models[0]?.id ?? ""}` : "";
          }
        });
        if (loginId) logins.consume(loginId);
        if (previous?.secretRef) await credentials.remove(previous.secretRef);
        return providerInfo(stored);
      },
      async "provider.remove"({ id }) {
        idle();
        const previous = read().providers.find((item) => item.id === id);
        await update((draft) => {
          draft.providers = draft.providers.filter((item) => item.id !== id);
          if (draft.defaultModel.startsWith(`${id}:`)) {
            const next = draft.providers.find((item) => item.enabled && item.models.length);
            draft.defaultModel = next ? `${next.id}:${next.models[0]?.id ?? ""}` : "";
          }
        });
        if (previous) await credentials.remove(previous.secretRef);
        return null;
      },
      async "settings.update"(change) {
        if (change.defaultModel !== undefined) idle();
        await update((draft) => {
          if (change.theme) draft.theme = change.theme;
          if (change.showThinking !== undefined) draft.showThinking = change.showThinking;
          if (change.defaultModel !== undefined) {
            if (
              change.defaultModel &&
              !read().providers.some(
                (provider) =>
                  provider.enabled &&
                  provider.models.some(
                    (model) => `${provider.id}:${model.id}` === change.defaultModel,
                  ),
              )
            )
              throw new Error("请选择有效模型。");
            draft.defaultModel = change.defaultModel;
          }
        }, false);
        return await info();
      },
      async "capability.setEnabled"({ id, enabled }) {
        idle();
        if (modeSkillIds.has(id) && !enabled)
          throw new Error("基础技能随场景搭建模式加载；工具可独立停用。");
        await update((draft) => {
          const disabled = new Set(draft.disabledCapabilities ?? []);
          if (enabled) disabled.delete(id);
          else disabled.add(id);
          draft.disabledCapabilities = [...disabled];
        }, false);
        if (!enabled) await releaseBuiltin(id);
        return await info();
      },
      async "auth.start"({ providerType, method }) {
        return logins.start(providerType, method);
      },
      async "auth.answer"({ id, promptId, value }) {
        return logins.answer(id, promptId, value);
      },
      async "auth.status"({ id }) {
        return logins.status(id);
      },
      async "auth.cancel"({ id }) {
        logins.cancel(id);
        return null;
      },
      async "auth.open"() {
        throw new Error("浏览器授权由桌面宿主处理。");
      },
      async "skill.save"({ config }) {
        idle();
        if (config.id.startsWith("builtin")) throw new Error("内置技能不能通过自定义配置覆盖。");
        if (!config.name.trim() || !config.description.trim() || !config.body.trim())
          throw new Error("技能名称、描述和正文不能为空。");
        if (config.sceneProfile && !config.modes.includes("scene"))
          throw new Error("业务场景技能必须启用场景搭建模式。");
        if (config.scope.kind === "project") await projects.visible(config.scope.projectId);
        const previous = read().skills ?? [];
        if (!previous.some((skill) => skill.id === config.id) && previous.length >= 100)
          throw new Error("最多可配置 100 个自定义技能。");
        const value = {
          ...config,
          name: config.name.trim(),
          description: config.description.trim(),
          body: config.body.trim(),
        };
        await update((draft) => {
          draft.skills = previous.some((skill) => skill.id === value.id)
            ? previous.map((skill) => (skill.id === value.id ? value : skill))
            : [...previous, value];
        }, false);
        const oldImages = previous.find((skill) => skill.id === value.id)?.images ?? [];
        await removeSkillImages(
          imagesRoot,
          value.id,
          oldImages
            .filter((image) => !value.images?.some((item) => item.path === image.path))
            .map((image) => image.path),
        );
        return value;
      },
      async "skill.image.add"({ id, name, image }) {
        idle();
        if (id.startsWith("builtin")) throw new Error("请先复制内置技能再添加图片。");
        return { name, path: await addSkillImage(imagesRoot, id, image) };
      },
      async "skill.image.read"({ id, path }) {
        return readSkillImage(imagesRoot, id, path);
      },
      async "skill.image.remove"({ id, path }) {
        if (id.startsWith("builtin")) throw new Error("内置技能图片不能移除。");
        if (
          read()
            .skills?.find((skill) => skill.id === id)
            ?.images?.some((image) => image.path === path)
        )
          throw new Error("已保存技能正在使用此图片。");
        await removeSkillImages(imagesRoot, id, [path]);
        return null;
      },
      async "skill.remove"({ id }) {
        idle();
        if (id.startsWith("builtin")) throw new Error("内置基础技能随模式加载，不能移除。");
        await update((draft) => {
          draft.skills = (draft.skills ?? []).filter((skill) => skill.id !== id);
        }, false);
        await removeSkillImages(imagesRoot, id);
        return null;
      },
    };
    return handlers;
  }
  return {
    providers,
    model(selection: string) {
      for (const config of read().providers) {
        if (!config.enabled) continue;
        const choice = config.models.find((item) => `${config.id}:${item.id}` === selection);
        if (choice) return providers.models.getModel(config.id, choice.id);
      }
      return undefined;
    },
    initialize,
    read,
    update,
    info,
    credentials,
    requests,
    enabled: (id: string) => modeSkillIds.has(id) || !read().disabledCapabilities?.includes(id),
  };
}
export type Settings = Awaited<ReturnType<typeof createSettings>>;
