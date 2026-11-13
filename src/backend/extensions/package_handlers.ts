import type { openProjectStore } from "../projects/store.ts";
import type { Handlers } from "../types.ts";
import { createPackageService } from "./package_service.ts";

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

  async function withService<T>(
    projectId: string | undefined,
    action: (manager: ReturnType<typeof createPackageService>) => Promise<T>,
  ) {
    const manager = service(projectId);
    try {
      return await action(manager);
    } finally {
      await manager.dispose();
    }
  }

  return {
    async "package.list"({ projectId }) {
      return withService(projectId, (manager) => manager.list());
    },
    async "package.update"({ source, projectId }) {
      // Pi update 可能同时更新用户与项目作用域，先确保所有会话空闲。
      await options.changed?.();
      await withService(projectId, (manager) => manager.update(source));
      return null;
    },
    async "package.install"({ source, scope, projectId }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      await withService(projectId, (manager) => manager.install(source, scope));
      return null;
    },
    async "package.remove"({ source, scope, projectId }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      await withService(projectId, (manager) => manager.remove(source, scope));
      return null;
    },
    async "package.setEnabled"({ source, scope, projectId, enabled }) {
      await options.changed?.(scope === "user" ? undefined : projectId);
      await withService(projectId, (manager) => manager.setEnabled(source, scope, enabled));
      return null;
    },
  };
}
