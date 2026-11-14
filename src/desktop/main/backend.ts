import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import {
  type ApplicationEvent,
  type Arguments,
  type Method,
  type Results,
  validateRequest,
  validateResult,
  validEvent,
} from "../../contracts/application.ts";
import type { BackendMessage } from "../../contracts/process.ts";

const REQUEST_TIMEOUT_MS = 30_000;

// 主进程通过请求 ID 关联后端响应并转发事件。
export function connectBackend(child: UtilityProcess, publish: (event: ApplicationEvent) => void) {
  let exited = false;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  child.on("message", (data: BackendMessage) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "event") {
      // 事件必须符合跨进程契约，才能发给界面。
      if (validEvent(data.event)) publish(data.event);
      else console.error("Application event contract mismatch.");
    } else if (data.type === "response") {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.ok) request.resolve(data.result);
      else request.reject(new Error(data.error));
    }
  });

  child.once("exit", () => {
    exited = true;
    // 后端退出后，所有尚未完成的请求都要结束，避免界面一直等待。
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("应用后端已退出。"));
    }
    pending.clear();
  });

  function send(message: object, validate: (value: unknown) => void): Promise<unknown> {
    if (exited) return Promise.reject(new Error("应用后端已退出。"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("后端请求超时，请检查当前状态后再试。"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          try {
            validate(value);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
        reject,
        timer,
      });
      child.postMessage({ ...message, version: 1, id });
    });
  }

  return {
    async request<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
      validateRequest(method, args);
      const value = await send({ type: "request", method, args }, (value) =>
        validateResult(method, value),
      );
      return value as Results[K];
    },
  };
}
