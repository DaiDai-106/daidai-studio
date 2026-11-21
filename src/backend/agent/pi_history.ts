import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { openProjectStore } from "../projects/store.ts";

/** 使用 Pi 原生 JSONL 会话；产品会话 ID 和 Pi 文件路径分别管理。 */
export function createPiHistory(store: ReturnType<typeof openProjectStore>, dataRoot: string) {
  const managers = new Map<string, SessionManager>();

  function getSessionContext(id: string) {
    const conversation = store.getConversation(id);
    if (!conversation) throw new Error("会话不存在。");
    const project = store.getProject(conversation.projectId);
    if (!project) throw new Error("项目不存在。");
    const directory = join(dataRoot, "agent", "sessions", project.id);
    if (conversation.sessionFile) {
      const rel = relative(directory, conversation.sessionFile);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.endsWith(".jsonl"))
        throw new Error("会话文件路径无效。");
    }
    return { conversation, project, directory };
  }

  function lookup(id: string) {
    const { conversation, project, directory } = getSessionContext(id);
    let manager = managers.get(id);
    if (!manager && conversation.sessionFile && existsSync(conversation.sessionFile)) {
      manager = SessionManager.open(conversation.sessionFile, directory, project.path);
      managers.set(id, manager);
    }
    if (!manager && conversation.hasMessages)
      throw new Error("会话历史文件丢失，无法恢复聊天记录。");
    return { manager, project, directory };
  }

  return {
    read(id: string) {
      return lookup(id).manager;
    },
    open(id: string): SessionManager {
      const { manager: existing, project, directory } = lookup(id);
      if (existing) return existing;

      // Pi 在第一条消息前不创建文件；空会话在重启后可以安全地重新创建。
      const manager = SessionManager.create(project.path, directory);
      const file = manager.getSessionFile();
      if (!file) throw new Error("无法创建会话文件。");
      store.updateConversation(id, { sessionFile: file });
      managers.set(id, manager);
      return manager;
    },

    forget(id: string) {
      managers.delete(id);
    },

    fork(id: string) {
      const { conversation, project, directory } = getSessionContext(id);
      const file = conversation.sessionFile;
      let newFile: string | null = null;
      if (conversation.hasMessages && (!file || !existsSync(file)))
        throw new Error("会话历史文件丢失，无法恢复聊天记录。");
      if (file && existsSync(file)) {
        const forked = SessionManager.forkFrom(file, project.path, directory);
        newFile = forked.getSessionFile() ?? null;
        if (!newFile) throw new Error("无法创建会话分叉。");
      }

      const branch = store.createConversation(project.id, conversation.modelId, newFile);
      return store.updateConversation(branch.id, {
        title: `${conversation.title.slice(0, 195)}（分叉）`,
        thinkingLevel: conversation.thinkingLevel,
        hasMessages: Boolean(newFile),
      });
    },
  };
}
