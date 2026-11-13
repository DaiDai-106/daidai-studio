import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCodingFileService } from "../../../src/backend/coding/file_service.ts";
import { createCodingGitService } from "../../../src/backend/coding/git_service.ts";
import { openProjectStore } from "../../../src/backend/projects/store.ts";

test("Git 差异按项目目录区分暂存、未暂存和未跟踪文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-git-"));
  const work = join(root, "repo");
  const projectDir = join(work, "sub");
  await mkdir(projectDir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(projectDir, "tracked.ts"), "old\n");
    await writeFile(join(work, "outside.txt"), "old\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    await writeFile(join(projectDir, "tracked.ts"), "staged\n");
    git("add", "sub/tracked.ts");
    await writeFile(join(projectDir, "tracked.ts"), "unstaged\n");
    await writeFile(join(projectDir, "new[1].py"), "print('hello')\n");
    await writeFile(join(work, "outside.txt"), "changed\n");
    const store = openProjectStore(join(root, "data"));
    try {
      const project = store.createProject({ name: "代码", mode: "coding", path: projectDir });
      const files = createCodingFileService(store);
      const service = createCodingGitService(store, files);
      const result = await service.changes(project.id);
      assert.equal(result.entries.length, 2);
      const tracked = result.entries.find((entry) => entry.path === "tracked.ts");
      assert.ok(tracked?.staged && tracked.unstaged);
      assert.ok(result.entries.find((entry) => entry.path === "new[1].py")?.untracked);
      assert.match((await service.diff(project.id, "tracked.ts", "staged")).patch, /\+staged/);
      assert.match((await service.diff(project.id, "tracked.ts", "unstaged")).patch, /\+unstaged/);
      assert.match((await service.diff(project.id, "new[1].py", "untracked")).patch, /\+print/);
      await assert.rejects(service.diff(project.id, "../outside.txt", "unstaged"), /路径无效/);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("无首次提交的仓库和非仓库均显示真实状态", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-git-empty-"));
  const repo = join(root, "repo");
  const plain = join(root, "plain");
  await mkdir(repo);
  await mkdir(plain);
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(join(repo, "new.ts"), "const a = 1;\n");
    execFileSync("git", ["add", "new.ts"], { cwd: repo });
    const store = openProjectStore(join(root, "data"));
    try {
      const first = store.createProject({ name: "代码", mode: "coding", path: repo });
      const second = store.createProject({ name: "普通目录", mode: "coding", path: plain });
      const service = createCodingGitService(store, createCodingFileService(store));
      assert.equal((await service.changes(first.id)).entries[0]?.staged, true);
      assert.match((await service.diff(first.id, "new.ts", "staged")).patch, /\+const a = 1/);
      await assert.rejects(service.changes(second.id), /无法读取 Git/);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("查看 Git 状态和差异不会执行仓库配置的清理过滤器", async () => {
  const root = await mkdtemp(join(tmpdir(), "dai-git-filter-"));
  const repo = join(root, "repo");
  const marker = join(root, "filter-ran");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("config", "filter.spy.clean", `touch '${marker}'; cat`);
    await writeFile(join(repo, ".gitattributes"), "*.ts filter=spy\n");
    await writeFile(join(repo, "file.ts"), "old\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    await rm(marker, { force: true });
    await writeFile(join(repo, "file.ts"), "new\n");
    const store = openProjectStore(join(root, "data"));
    try {
      const project = store.createProject({ name: "代码", mode: "coding", path: repo });
      const service = createCodingGitService(store, createCodingFileService(store));
      await assert.rejects(service.changes(project.id), /过滤器/);
      await assert.rejects(service.diff(project.id, "file.ts", "unstaged"), /过滤器/);
      const { access } = await import("node:fs/promises");
      await assert.rejects(access(marker));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
