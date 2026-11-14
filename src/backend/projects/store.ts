import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AccessMode, ThinkingLevel } from "../../contracts/application.ts";
import type { ConversationMode } from "../../contracts/capabilities.ts";

export interface StoredProject {
  id: string;
  name: string;
  mode: ConversationMode;
  path: string;
}

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

/** Dai 自身的数据位于数据根目录；项目路径只是工具的工作目录。 */
export function openProjectStore(dataRoot: string) {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataRoot, "projects.sqlite"));
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
  `);
  // 兼容新版开发期间创建的数据表，不改变已有会话内容。
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "thinking_level"))
    db.exec("ALTER TABLE conversations ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'");
  if (!columns.some((column) => column.name === "access_mode"))
    db.exec("ALTER TABLE conversations ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'ask'");
  if (!columns.some((column) => column.name === "interrupted"))
    db.exec("ALTER TABLE conversations ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "has_messages"))
    db.exec("ALTER TABLE conversations ADD COLUMN has_messages INTEGER NOT NULL DEFAULT 0");
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColumns.some((column) => column.name === "hidden"))
    db.exec("ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");

  function project(id: string): StoredProject | undefined {
    return db
      .prepare(
        "SELECT id, name, mode, path FROM projects WHERE id = ? AND hidden = 0 AND mode = 'coding'",
      )
      .get(id) as StoredProject | undefined;
  }

  function anyProject(id: string): StoredProject | undefined {
    return db
      .prepare("SELECT id, name, mode, path FROM projects WHERE id = ? AND mode = 'coding'")
      .get(id) as StoredProject | undefined;
  }

  function requireProject(id: string) {
    const result = project(id);
    if (!result) throw new Error("项目不存在。");
    return result;
  }

  function conversation(id: string): StoredConversation | undefined {
    const row = db
      .prepare(`SELECT id, project_id AS projectId, title, created_at AS createdAt, model_id AS modelId,
      draft, archived, session_file AS sessionFile, thinking_level AS thinkingLevel, access_mode AS accessMode, interrupted,
      has_messages AS hasMessages
      FROM conversations WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE mode = 'coding')`)
      .get(id) as
      | (Omit<StoredConversation, "archived" | "interrupted" | "hasMessages"> & {
          archived: number;
          interrupted: number;
          hasMessages: number;
        })
      | undefined;
    return (
      row && {
        ...row,
        accessMode: row.accessMode === "full" ? "full" : "ask",
        archived: Boolean(row.archived),
        interrupted: Boolean(row.interrupted),
        hasMessages: Boolean(row.hasMessages),
      }
    );
  }

  function requireConversation(id: string) {
    const result = conversation(id);
    if (!result) throw new Error("会话不存在。");
    return result;
  }

  return {
    createProject(input: { name: string; mode: ConversationMode; path: string }): StoredProject {
      const name = input.name.trim();
      if (!name || name.length > 200) throw new Error("项目名称无效。");
      if (input.mode !== "coding") throw new Error("项目模式无效。");
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
    getAnyProject: anyProject,
    listProjects(): StoredProject[] {
      return db
        .prepare(
          "SELECT id, name, mode, path FROM projects WHERE hidden = 0 AND mode = 'coding' ORDER BY created_at DESC, rowid DESC",
        )
        .all() as unknown as StoredProject[];
    },

    listHiddenProjects(): StoredProject[] {
      return db
        .prepare(
          "SELECT id, name, mode, path FROM projects WHERE hidden = 1 AND mode = 'coding' ORDER BY created_at DESC, rowid DESC",
        )
        .all() as unknown as StoredProject[];
    },

    hideProject(id: string) {
      requireProject(id);
      db.prepare("UPDATE projects SET hidden = 1 WHERE id = ?").run(id);
    },

    restoreProject(id: string) {
      if (!anyProject(id)) throw new Error("项目不存在。");
      db.prepare("UPDATE projects SET hidden = 0 WHERE id = ?").run(id);
      return requireProject(id);
    },

    deleteProject(id: string) {
      requireProject(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    },

    createConversation(projectId: string, modelId = "", sessionFile: string | null = null) {
      requireProject(projectId);
      const id = randomUUID();
      db.prepare(`INSERT INTO conversations (id, project_id, title, model_id, session_file, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, "新会话", modelId, sessionFile, Date.now());
      return requireConversation(id);
    },
    getConversation: conversation,
    listConversations(projectId: string): StoredConversation[] {
      requireProject(projectId);
      const rows = db
        .prepare(
          "SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC",
        )
        .all(projectId) as { id: string }[];
      return rows.map((row) => requireConversation(row.id));
    },

    listConversationPage(cursor?: { createdAt: number; id: string }, limit = 100) {
      const rows = (
        cursor
          ? db
              .prepare(`SELECT c.id, c.created_at AS createdAt FROM conversations c
            JOIN projects p ON p.id = c.project_id AND p.hidden = 0 AND p.mode = 'coding'
            WHERE (c.created_at < ? OR (c.created_at = ? AND c.id < ?))
            ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
              .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
          : db
              .prepare(
                "SELECT c.id, c.created_at AS createdAt FROM conversations c JOIN projects p ON p.id = c.project_id AND p.hidden = 0 AND p.mode = 'coding' ORDER BY c.created_at DESC, c.id DESC LIMIT ?",
              )
              .all(limit + 1)
      ) as { id: string; createdAt: number }[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => requireConversation(row.id)),
        next: rows.length > limit ? last : undefined,
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
