import { createPackageService } from "./extensions/packageService.ts";
import type { openProjectStore } from "./projects/store.ts";
import type { Handlers } from "./types.ts";

export function createPackageHandlers(options: {
  dataRoot: string;
  store: ReturnType<typeof openProjectStore>;
  changed?: (projectId?: string) => Promise<void> | void;
}): Handlers<
  "package.list" | "package.update" | "package.install" | "package.remove" | "package.setEnabled"
> {
  function service(projectId?: string) {
    const project = projectId ? options.store.getProject(projectId) : undefined;
    if (projectId && !project) throw new Error("项目不存在。");
    return createPackageService({
      dataRoot: options.dataRoot,
      ...(project ? { projectId: project.id, cwd: project.path } : {}),
    });
  }
  return {
    async "package.list"({ projectId }) {
      const manager = service(projectId);
      try {
        return await manager.list();
      } finally {
        await manager.dispose();
      }
    },
    async "package.update"({ source, projectId }) {
      // Pi update 可能同时更新用户与项目作用域，先确保所有会话空闲。
      await options.changed?.();
      const manager = service(projectId);
      try {
        await manager.update(source);
      } finally {
        await manager.dispose();
      }
      return null;
    },
    async "package.install"({ source, scope, projectId }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      const manager = service(projectId);
      try {
        await manager.install(source, scope);
      } finally {
        await manager.dispose();
      }
      return null;
    },
    async "package.remove"({ source, scope, projectId }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      const manager = service(projectId);
      try {
        await manager.remove(source, scope);
      } finally {
        await manager.dispose();
      }
      return null;
    },
    async "package.setEnabled"({ source, scope, projectId, enabled }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      const manager = service(projectId);
      try {
        await manager.setEnabled(source, scope, enabled);
      } finally {
        await manager.dispose();
      }
      return null;
    },
  };
}
