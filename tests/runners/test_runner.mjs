import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const arguments_ = process.argv.slice(2);
const listOnly = arguments_.length === 1 && arguments_[0] === "--list";
const patterns = listOnly ? [] : arguments_;
const allFiles = globSync("tests/**/*.test.ts", { cwd: root }).map((file) =>
  file.replaceAll("\\", "/"),
);
const files = [
  ...new Set(
    patterns.length ? patterns.flatMap((pattern) => globSync(pattern, { cwd: root })) : allFiles,
  ),
].sort();

if (listOnly) {
  for (const file of files) console.log(file);
  process.exit(files.length ? 0 : 1);
}

if (!files.length) {
  console.error("No test files matched.");
  process.exitCode = 1;
} else {
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let failedFiles = 0;

  for (const file of files) {
    console.log(`\n# Test file: ${file}`);
    const counts = {};
    let buffered = "";
    // Node 22 的隔离式 TypeScript 测试统计会把整个文件算作一个通过项，
    // 包内所有用例跳过也会显示为通过。每个文件独立进程运行，进程内
    // 关闭二次隔离，既保留文件间隔离，也能输出真实用例和跳过数量。
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-test-isolation=none",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=1",
        file,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
        if (match) counts[match[1]] = Number(match[2]);
      }
    });
    const result = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.error || result.code !== 0 || !counts.tests) {
      failedFiles++;
      if (result.error) console.error(`Failed to start ${file}: ${result.error.message}`);
      else if (!counts.tests) console.error(`No test results for ${file}.`);
      else console.error(`Test file failed: ${file} (${result.signal ?? result.code}).`);
    }
    for (const name of Object.keys(totals)) totals[name] += counts[name] ?? 0;
  }

  console.log("\n# Overall test results");
  for (const [name, count] of Object.entries(totals)) console.log(`# ${name} ${count}`);
  console.log(`# failed files ${failedFiles}`);
  if (!totals.pass) console.error("No tests passed; skipped or empty suites are not verification.");
  if (failedFiles || totals.fail || totals.cancelled || !totals.pass) process.exitCode = 1;
}
