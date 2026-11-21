import type { AuthEvent, AuthInteraction, AuthPrompt, Credential } from "@earendil-works/pi-ai";
import type { LoginInfo, ProviderConfig } from "../../contracts/application.ts";
import { productName } from "../../shared/app_metadata.ts";
import type { Providers } from "./providers.ts";

type Attempt = {
  info: LoginInfo;
  controller: AbortController;
  credential?: Credential;
  answer?: { id: string; resolve: (value: string) => void; reject: (reason: Error) => void };
};

export function createLogins(
  providers: Providers,
  deviceId: string,
  publish: (login: LoginInfo) => void,
) {
  const attempts = new Map<string, Attempt>();

  function get(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) throw new Error("授权尝试已结束，请重新登录。");
    return attempt;
  }

  function update(attempt: Attempt) {
    publish(structuredClone(attempt.info));
  }

  function cancel(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    attempt.controller.abort();
    attempt.answer?.reject(new Error("授权已取消。"));
    attempt.info.status = "cancelled";
    attempt.info.prompt = null;
    delete attempt.credential;
    update(attempt);
    attempts.delete(id);
  }

  function start(providerType: string, method: "api_key" | "oauth") {
    // 桌面提示同一时间只属于一个尚未保存的授权流程。
    for (const id of attempts.keys()) cancel(id);
    const auth = providers.authDefinition(providerType);
    const login =
      method === "oauth"
        ? auth.oauth?.login.bind(auth.oauth)
        : auth.apiKey?.login?.bind(auth.apiKey);
    if (!login) throw new Error("此服务不提供该登录流程。");

    const attempt: Attempt = {
      info: {
        id: crypto.randomUUID(),
        providerType,
        method,
        status: "waiting",
        message: "等待授权",
        url: "",
        code: "",
        prompt: null,
      },
      controller: new AbortController(),
    };
    attempts.set(attempt.info.id, attempt);

    const interaction: AuthInteraction = {
      signal: attempt.controller.signal,
      prompt(prompt: AuthPrompt) {
        return new Promise<string>((resolve, reject) => {
          if (attempt.controller.signal.aborted || prompt.signal?.aborted) {
            reject(new Error("授权已取消。"));
            return;
          }

          const promptId = crypto.randomUUID();
          const cleanup = () => {
            prompt.signal?.removeEventListener("abort", aborted);
            attempt.controller.signal.removeEventListener("abort", aborted);
          };

          const aborted = () => {
            cleanup();
            if (attempt.answer?.id === promptId) {
              delete attempt.answer;
              attempt.info.prompt = null;
              update(attempt);
            }
            reject(new Error("授权已取消。"));
          };

          attempt.answer = {
            id: promptId,
            resolve: (value) => {
              cleanup();
              resolve(value);
            },
            reject: (error) => {
              cleanup();
              reject(error);
            },
          };
          prompt.signal?.addEventListener("abort", aborted, { once: true });
          attempt.controller.signal.addEventListener("abort", aborted, { once: true });
          attempt.info.prompt = {
            id: promptId,
            type: prompt.type,
            message: prompt.message,
            placeholder: "placeholder" in prompt ? (prompt.placeholder ?? "") : "",
            options:
              prompt.type === "select"
                ? prompt.options.map(({ id, label }) => ({ id, label }))
                : [],
          };
          update(attempt);
        });
      },

      notify(event: AuthEvent) {
        if (attempt.controller.signal.aborted) return;
        if (event.type === "auth_url") {
          attempt.info.url = event.url;
          attempt.info.message = event.instructions ?? "请在系统浏览器完成授权。";
        } else if (event.type === "device_code") {
          attempt.info.url = event.verificationUri;
          attempt.info.code = event.userCode;
        } else attempt.info.message = event.message;
        update(attempt);
      },
    };

    void login(
      { ...interaction, signal: attempt.controller.signal },
      { getDeviceId: () => deviceId, agentName: productName },
    ).then(
      (credential) => {
        if (attempt.controller.signal.aborted) return;
        attempt.credential = credential;
        attempt.info.status = "success";
        attempt.info.prompt = null;
        attempt.info.message =
          method === "api_key"
            ? "API Key 已接收，可用性在请求时验证；保存服务后才保留。"
            : "账号授权成功，保存服务后才保留账号。";
        update(attempt);
      },
      () => {
        if (!attempt.controller.signal.aborted) {
          attempt.info.status = "error";
          attempt.info.prompt = null;
          attempt.info.message = "认证失败或已过期，请重新开始。";
          update(attempt);
        }
      },
    );
    return structuredClone(attempt.info);
  }

  return {
    start,
    cancel,
    status: (id: string) => structuredClone(get(id).info),
    answer(id: string, promptId: string, value: string) {
      const attempt = get(id);
      if (attempt.answer?.id !== promptId) throw new Error("此输入提示已失效。");
      const answer = attempt.answer;
      delete attempt.answer;
      attempt.info.prompt = null;
      answer.resolve(value);
      return structuredClone(attempt.info);
    },

    credential(id: string, config: ProviderConfig) {
      const attempt = get(id);
      if (
        attempt.info.providerType !== config.providerType ||
        attempt.info.method !== config.authMethod ||
        !attempt.credential
      )
        throw new Error("认证与当前服务不匹配。");
      return attempt.credential;
    },

    replaceCredential(id: string, expected: Credential, credential: Credential) {
      const attempt = attempts.get(id);
      if (attempt?.credential === expected) attempt.credential = credential;
    },
    consume(id: string) {
      const attempt = get(id);
      delete attempt.credential;
      attempts.delete(id);
    },
    close() {
      for (const id of attempts.keys()) cancel(id);
    },
  };
}
