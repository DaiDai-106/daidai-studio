import type { ApplicationEvent, Arguments, Method } from "./application.ts";

/** 进程间绑定同一数据根；十进制字符串避免 inode 的整数精度损失。 */
export type DataRootIdentity = { dev: string; ino: string };

// 请求与响应以同一个 ID 配对，version 用于检查通信协议兼容性。
export type BackendRequest = {
  type: "request";
  version: 1;
  id: string;
  deadline: number;
  method: Method;
  args: Arguments<Method>;
};
type BackendResponse = { type: "response"; id: string } & (
  | { ok: true; result: unknown }
  | { ok: false; error: string }
);
export type BackendMessage = BackendResponse | { type: "event"; event: ApplicationEvent };
