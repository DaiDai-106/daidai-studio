import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { App } from "electron";
import { createSceneResourceReader } from "./resource_reader.ts";

type PathHooks = { beforeMkdir?: (name: string) => void };
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// Linux 通过已固定的父目录创建缺失路径；任何最终目录项都不能是新替换的符号链接。
function openOrCreateDirectory(input: string, hooks: PathHooks) {
  let existing = resolve(input);
  const missing: string[] = [];
  let canonical: string;

  for (;;) {
    try {
      canonical = realpathSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  const path = join(canonical, ...missing);
  const parts = path.split("/").filter(Boolean);
  const existingCount = parts.length - missing.length;
  let handle = openSync("/", directoryFlags);
  try {
    for (const [index, name] of parts.entries()) {
      const childPath = `/proc/self/fd/${handle}/${name}`;
      if (index >= existingCount) {
        hooks.beforeMkdir?.(name);
        try {
          mkdirSync(childPath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const child = openSync(childPath, directoryFlags);
      closeSync(handle);
      handle = child;
    }
    return { path, handle };
  } catch (error) {
    closeSync(handle);
    throw error;
  }
}

function verifyDirectoryPath(path: string, handle: number) {
  const expected = fstatSync(handle, { bigint: true });
  const actual = statSync(path, { bigint: true });
  if (!actual.isDirectory() || expected.dev !== actual.dev || expected.ino !== actual.ino)
    throw new Error("启动时应用数据目录发生变化，请重试。");
}

export function configureDataPaths(app: App, hooks: PathHooks = {}) {
  const isolated = app.commandLine.getSwitchValue("user-data-dir");
  const configuredRoot = isolated ? join(isolated, "data") : join(app.getPath("home"), ".dai");

  if (process.platform !== "linux") {
    mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(configuredRoot);
    const profile = isolated || join(root, "desktop");
    for (const path of [profile, join(root, "logs"), join(root, "cache"), join(root, "tmp")])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    app.setPath("userData", profile);
    app.setAppLogsPath(join(root, "logs"));
    return {
      root,
      configuredRoot,
      profile,
      database: join(root, "app.sqlite"),
      resourceReader: createSceneResourceReader(root),
    };
  }

  const isolatedDirectory = isolated ? openOrCreateDirectory(isolated, hooks) : undefined;
  let rootDirectory: ReturnType<typeof openOrCreateDirectory> | undefined;
  try {
    const rootInput = isolatedDirectory ? join(isolatedDirectory.path, "data") : configuredRoot;
    rootDirectory = openOrCreateDirectory(rootInput, hooks);
    const root = rootDirectory.path;
    verifyDirectoryPath(configuredRoot, rootDirectory.handle);
    for (const name of isolatedDirectory
      ? ["logs", "cache", "tmp"]
      : ["desktop", "logs", "cache", "tmp"]) {
      const path = `/proc/self/fd/${rootDirectory.handle}/${name}`;
      hooks.beforeMkdir?.(name);
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const child = openSync(path, directoryFlags);
      closeSync(child);
    }

    verifyDirectoryPath(configuredRoot, rootDirectory.handle);
    verifyDirectoryPath(root, rootDirectory.handle);
    if (isolatedDirectory) verifyDirectoryPath(isolated, isolatedDirectory.handle);
    const profile = isolatedDirectory?.path ?? join(root, "desktop");
    const resourceReader = createSceneResourceReader(root, {}, rootDirectory.handle);
    try {
      app.setPath("userData", profile);
      app.setAppLogsPath(join(root, "logs"));
    } catch (error) {
      resourceReader.close();
      throw error;
    }
    return {
      root,
      configuredRoot,
      profile,
      database: join(root, "app.sqlite"),
      resourceReader,
    };
  } finally {
    if (rootDirectory) closeSync(rootDirectory.handle);
    if (isolatedDirectory) closeSync(isolatedDirectory.handle);
  }
}
