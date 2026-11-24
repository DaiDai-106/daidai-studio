import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { PlanningSource } from "../../../contracts/planning.ts";

type Request = { method: "loadScene"; kind: PlanningSource; path: string } | { method: "getScene" };
const maxResponseLength = 8 * 1024 * 1024;

export function startPlanningWorker(path: string, onStop: () => void) {
  const child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const output = child.stdio[3] as Readable;
  let logs = "";
  let message = "";
  let failure: Error | undefined;
  let pending:
    | {
        id: string;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function takePending() {
    const request = pending;
    pending = undefined;
    clearTimeout(request?.timer);
    return request;
  }

  function stop(error: Error) {
    if (failure) return;
    failure = error;
    takePending()?.reject(error);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    onStop();
  }

  function appendLogs(chunk: string) {
    logs = (logs + chunk).slice(-8192);
  }
  child.stdout.setEncoding("utf8").on("data", appendLogs);
  child.stderr.setEncoding("utf8").on("data", appendLogs);
  child.once("error", (error: NodeJS.ErrnoException) => {
    stop(
      new Error(
        error.code === "ENOENT" || error.code === "EACCES"
          ? "One Punch 规划程序不可用。请先构建规划模块。"
          : "无法启动 One Punch 规划程序。",
        { cause: error },
      ),
    );
  });
  child.once("close", () => stop(new Error("One Punch 规划程序已退出。")));
  child.stdin.on("error", (error) =>
    stop(new Error("无法向 One Punch 发送请求。", { cause: error })),
  );
  output.on("error", (error) => stop(new Error("无法读取 One Punch 响应。", { cause: error })));

  output.setEncoding("utf8").on("data", (chunk: string) => {
    message += chunk;
    if (message.length > maxResponseLength) {
      stop(new Error("One Punch 场景响应过大。"));
      return;
    }
    const end = message.indexOf("\n");
    if (end < 0) return;
    try {
      const reply = JSON.parse(message.slice(0, end));
      message = message.slice(end + 1);
      if (!pending || reply?.id !== pending.id || typeof reply.ok !== "boolean")
        throw new Error("One Punch 请求与响应不匹配。");
      const request = takePending();
      if (reply.ok) request?.resolve(reply.scene);
      else {
        const details = stripVTControlCharacters(logs)
          .split("\n")
          .findLast((line) => line.includes("[ERROR]"))
          ?.split("] ")
          .at(-1)
          ?.trim();
        const reason = typeof reply.error === "string" ? reply.error : "操作失败。";
        request?.reject(new Error(details ? `${reason} ${details.slice(0, 500)}` : reason));
      }
    } catch (error) {
      stop(new Error("One Punch 场景响应格式无效。", { cause: error }));
    }
  });

  return {
    get available() {
      return !failure && child.exitCode === null && child.signalCode === null;
    },
    request(input: Request): Promise<unknown> {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error("One Punch 正在处理场景。"));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        logs = "";
        const timer = setTimeout(() => stop(new Error("One Punch 场景请求超时。")), 60_000);
        pending = { id, resolve, reject, timer };
        child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
      });
    },
    close() {
      stop(new Error("One Punch 规划程序已关闭。"));
    },
  };
}
