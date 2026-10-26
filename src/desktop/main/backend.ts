import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import { Value } from "typebox/value";
import {
  type ApplicationEvent,
  type Arguments,
  type Method,
  type Results,
  validateRequest,
  validateResult,
  validEvent,
} from "../../shared/application.ts";
import type { BackendMessage, VaultResponse } from "../../shared/process.ts";
import { type ResourceLocation, ResourceLocationSchema } from "../../shared/process.ts";
import type { createVault } from "./vault.ts";

export function connectBackend(
  child: UtilityProcess,
  vault: ReturnType<typeof createVault>,
  publish: (event: ApplicationEvent) => void,
) {
  let exited = false;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  child.on("message", async (data: BackendMessage) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "event") {
      if (validEvent(data.event)) publish(data.event);
      else console.error("Application event contract mismatch.");
    } else if (data.type === "response") {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.ok) request.resolve(data.result);
      else request.reject(new Error(data.error));
    } else if (data.type === "vault") {
      let response: VaultResponse;
      try {
        let value = "";
        if (data.action === "read") value = await vault.read();
        else await vault.write(data.value ?? "");
        response = { type: "vault-result", id: data.id, ok: true, value };
      } catch (error) {
        response = {
          type: "vault-result",
          id: data.id,
          ok: false,
          error: error instanceof Error ? error.message : "凭据存储失败。",
        };
      }
      if (!exited) child.postMessage(response);
    }
  });
  child.once("exit", () => {
    exited = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("应用后端已退出。"));
    }
    pending.clear();
  });
  function send(
    message: object,
    validate: (value: unknown) => void,
    waitForCleanup = false,
  ): Promise<unknown> {
    if (exited) return Promise.reject(new Error("应用后端已退出。"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      // Inspection owns its timeout and awaited cleanup in the backend.
      // Racing it here would discard the result while its process is still running.
      const timer = waitForCleanup
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            reject(new Error("后端请求超时，请检查当前状态后再试。"));
          }, 30000);
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
    async resolveResource(importId: string, resourceId: string): Promise<ResourceLocation> {
      const value = await send({ type: "resource", importId, resourceId }, (value) => {
        if (!Value.Check(ResourceLocationSchema, value)) throw new Error("资源响应无效。");
      });
      return value as ResourceLocation;
    },
    async request<K extends Method>(method: K, args: Arguments<K>): Promise<Results[K]> {
      validateRequest(method, args);
      const value = await send(
        { type: "request", method, args },
        (value) => validateResult(method, value),
        method === "mcp.inspect" || method === "mcp.cancelInspect",
      );
      return value as Results[K];
    },
  };
}
