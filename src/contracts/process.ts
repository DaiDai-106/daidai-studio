import { type Static, Type } from "typebox";
import type { ApplicationEvent, Arguments, Method } from "./application.ts";

/** 进程间绑定同一数据根；十进制字符串避免 inode 的整数精度损失。 */
export type DataRootIdentity = { dev: string; ino: string };

// 主进程与后端之间只传资源身份；文件读取由主进程的受控目录句柄完成。
export type ResourceRequest = {
  type: "resource";
  version: 1;
  id: string;
  importId: string;
  resourceId: string;
};
export const ResourceLocationSchema = Type.Object(
  {
    projectId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    mediaType: Type.String({ maxLength: 100 }),
    byteLength: Type.Integer({ minimum: 0, maximum: 256 * 1024 * 1024 }),
  },
  { additionalProperties: false },
);
export type ResourceLocation = Static<typeof ResourceLocationSchema>;

// 请求与响应以同一个 ID 配对，version 用于检查通信协议兼容性。
export type BackendRequest = {
  type: "request";
  version: 1;
  id: string;
  method: Method;
  args: Arguments<Method>;
};
export type BackendResponse = { type: "response"; id: string } & (
  | { ok: true; result: unknown }
  | { ok: false; error: string }
);
export type BackendMessage = BackendResponse | { type: "event"; event: ApplicationEvent };
