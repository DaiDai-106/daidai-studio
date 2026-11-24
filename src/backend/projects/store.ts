import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccessMode,
  ChatImage,
  DeliveryMode,
  ProjectInfo,
  ThinkingLevel,
} from "../../contracts/application.ts";
import { isPluginModule, pluginModuleIds } from "../../contracts/catalog.ts";

type StoredProject = Omit<ProjectInfo, "available">;

const supportedModes = pluginModuleIds.map((mode) => `'${mode}'`).join(", ");

export interface StoredConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  modelId: string;
  draft: string;
  archived: boolean;
  sessionFile: string | null;
  thinkingLevel: ThinkingLevel;
  accessMode: AccessMode;
  interrupted: boolean;
  hasMessages: boolean;
}

type ConversationRow = Omit<StoredConversation, "archived" | "interrupted" | "hasMessages"> & {
  archived: number;
  interrupted: number;
  hasMessages: number;
};

const conversationColumns = `c.id, c.project_id AS projectId, c.title, c.created_at AS createdAt,
  c.model_id AS modelId, c.draft, c.archived, c.session_file AS sessionFile,
  c.thinking_level AS thinkingLevel, c.access_mode AS accessMode, c.interrupted,
  c.has_messages AS hasMessages`;

function decodeConversation(row: ConversationRow): StoredConversation {
  return {
    ...row,
    accessMode: row.accessMode === "full" ? "full" : "ask",
    archived: Boolean(row.archived),
    interrupted: Boolean(row.interrupted),
    hasMessages: Boolean(row.hasMessages),
  };
}

export interface QueuedMessage {
  id: string;
  text: string;
  delivery: DeliveryMode;
  images?: ChatImage[];
  stepAttachmentId?: string;
}

/** Dai 自身的数据位于数据根目录；项目路径只是工具的工作目录。 */
export function openProjectStore(dataRoot: string) {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataRoot, "projects.sqlite"));
  // 只接受当前表结构；检查在建表前完成，不修补或改写旧数据库。
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) {
      db.prepare("SELECT id, name, mode, path, created_at, hidden FROM projects LIMIT 0");
      db.prepare(`SELECT ${conversationColumns} FROM conversations c LIMIT 0`);
      db.prepare("SELECT conversation_id, id, body FROM conversation_queue LIMIT 0");
    }
  } catch (error) {
    db.close();
    throw new Error("项目数据库格式无效或已过期，请使用新的数据目录。", { cause: error });
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      path TEXT NOT NULL, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, model_id TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0, session_file TEXT, created_at INTEGER NOT NULL,
      thinking_level TEXT NOT NULL DEFAULT 'off', access_mode TEXT NOT NULL DEFAULT 'ask', interrupted INTEGER NOT NULL DEFAULT 0,
      has_messages INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS conversations_project ON conversations(project_id);
    CREATE TABLE IF NOT EXISTS conversation_queue (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (conversation_id, id)
    );
  `);
  function project(id: string): StoredProject | undefined {
    return db
      .prepare(
        `SELECT id, name, mode, path FROM projects WHERE id = ? AND hidden = 0 AND mode IN (${supportedModes})`,
      )
      .get(id) as StoredProject | undefined;
  }

  function listProjects(hidden: boolean): StoredProject[] {
    return db
      .prepare(
        `SELECT id, name, mode, path FROM projects WHERE hidden = ? AND mode IN (${supportedModes}) ORDER BY created_at DESC, rowid DESC`,
      )
      .all(Number(hidden)) as unknown as StoredProject[];
  }

  function requireProject(id: string) {
    const result = project(id);
    if (!result) throw new Error("项目不存在。");
    return result;
  }

  function conversation(id: string): StoredConversation | undefined {
    const row = db
      .prepare(`SELECT ${conversationColumns} FROM conversations c
        JOIN projects p ON p.id = c.project_id AND p.mode IN (${supportedModes}) WHERE c.id = ?`)
      .get(id) as ConversationRow | undefined;
    return row && decodeConversation(row);
  }

  function requireConversation(id: string) {
    const result = conversation(id);
    if (!result) throw new Error("会话不存在。");
    return result;
  }

  return {
    createProject(input: Omit<StoredProject, "id">): StoredProject {
      const name = input.name.trim();
      if (!name || name.length > 200) throw new Error("项目名称无效。");
      if (!isPluginModule(input.mode)) throw new Error("项目模式无效。");
      if (!isAbsolute(input.path)) throw new Error("项目目录必须是绝对路径。");
      const path = realpathSync(input.path);
      if (!statSync(path).isDirectory()) throw new Error("请选择本地项目目录。");
      const result = { id: randomUUID(), name, mode: input.mode, path };
      db.prepare(
        "INSERT INTO projects (id, name, mode, path, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(result.id, name, input.mode, path, Date.now());
      return result;
    },
    getProject: project,
    listProjects: () => listProjects(false),
    listHiddenProjects: () => listProjects(true),

    hideProject(id: string) {
      requireProject(id);
      db.prepare("UPDATE projects SET hidden = 1 WHERE id = ?").run(id);
    },

    restoreProject(id: string) {
      const restored = db
        .prepare(
          `UPDATE projects SET hidden = 0 WHERE id = ? AND mode IN (${supportedModes}) RETURNING id, name, mode, path`,
        )
        .get(id) as StoredProject | undefined;
      if (!restored) throw new Error("项目不存在。");
      return restored;
    },

    createConversation(projectId: string, modelId = "", sessionFile: string | null = null) {
      requireProject(projectId);
      const id = randomUUID();
      db.prepare(`INSERT INTO conversations (id, project_id, title, model_id, session_file, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, "新会话", modelId, sessionFile, Date.now());
      return requireConversation(id);
    },
    getConversation: conversation,
    usageHistories(): {
      projectId: string;
      sessionFile: string | null;
      hasMessages: number;
    }[] {
      return db
        .prepare(`SELECT c.project_id AS projectId, c.session_file AS sessionFile, c.has_messages AS hasMessages
        FROM conversations c JOIN projects p ON p.id = c.project_id WHERE p.mode IN (${supportedModes})`)
        .all() as {
        projectId: string;
        sessionFile: string | null;
        hasMessages: number;
      }[];
    },
    queuedMessages(id: string): QueuedMessage[] {
      requireConversation(id);
      return (
        db
          .prepare("SELECT body FROM conversation_queue WHERE conversation_id = ? ORDER BY rowid")
          .all(id) as { body: string }[]
      ).map((row) => JSON.parse(row.body) as QueuedMessage);
    },
    queueMessage(id: string, message: QueuedMessage, draft: string) {
      requireConversation(id);
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO conversation_queue (conversation_id, id, body) VALUES (?, ?, ?)",
        ).run(id, message.id, JSON.stringify(message));
        db.prepare("UPDATE conversations SET draft = '' WHERE id = ? AND draft = ?").run(id, draft);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    promoteQueuedMessage(id: string, messageId: string) {
      requireConversation(id);
      db.prepare(
        "UPDATE conversation_queue SET body = json_set(body, '$.delivery', 'steer') WHERE conversation_id = ? AND id = ?",
      ).run(id, messageId);
    },
    removeQueuedMessage(id: string, messageId: string) {
      requireConversation(id);
      db.prepare("DELETE FROM conversation_queue WHERE conversation_id = ? AND id = ?").run(
        id,
        messageId,
      );
    },
    listConversationPage(cursor?: { createdAt: number; id: string }, limit = 100) {
      const rows = db
        .prepare(`SELECT ${conversationColumns} FROM conversations c
          JOIN projects p ON p.id = c.project_id AND p.hidden = 0 AND p.mode IN (${supportedModes})
          ${cursor ? "WHERE (c.created_at, c.id) < (?, ?)" : ""}
          ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
        .all(
          ...(cursor ? [cursor.createdAt, cursor.id, limit + 1] : [limit + 1]),
        ) as ConversationRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(decodeConversation),
        next: rows.length > limit && last ? { id: last.id, createdAt: last.createdAt } : undefined,
      };
    },

    updateConversation(
      id: string,
      input: Partial<
        Pick<
          StoredConversation,
          | "title"
          | "modelId"
          | "draft"
          | "archived"
          | "sessionFile"
          | "thinkingLevel"
          | "accessMode"
          | "interrupted"
          | "hasMessages"
        >
      >,
    ) {
      const previous = requireConversation(id);
      const value = { ...previous, ...input };
      if (!value.title.trim() || value.title.length > 200 || value.draft.length > 100_000)
        throw new Error("会话数据无效。");
      db.prepare(
        "UPDATE conversations SET title = ?, model_id = ?, draft = ?, archived = ?, session_file = ?, thinking_level = ?, access_mode = ?, interrupted = ?, has_messages = ? WHERE id = ?",
      ).run(
        value.title,
        value.modelId,
        value.draft,
        Number(value.archived),
        value.sessionFile,
        value.thinkingLevel,
        value.accessMode,
        Number(value.interrupted),
        Number(value.hasMessages),
        id,
      );
      return requireConversation(id);
    },

    deleteConversation(id: string) {
      requireConversation(id);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    },

    close() {
      db.close();
    },
  };
}
