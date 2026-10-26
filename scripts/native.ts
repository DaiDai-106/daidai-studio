import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = join(root, "out/native");
const testing = process.argv[2] === "--test";
const runtime = process.argv[2] === "--runtime";
if (process.argv[2] && !testing && !runtime) throw new Error("Usage: native.ts [--test|--runtime]");
async function run(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env, shell: false });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code}).`)),
    );
  });
}
await run("cmake", ["-S", "resources/mcp", "-B", build, "-DCMAKE_BUILD_TYPE=Release"]);
await run("cmake", ["--build", build, "--config", "Release", "--parallel", "4"]);
if (runtime) {
  const directory = join(root, "out/native-runtime");
  await rm(directory, { recursive: true, force: true });
  await run("cmake", ["--install", build, "--config", "Release", "--prefix", directory]);
}
if (testing) {
  await run("ctest", ["--test-dir", build, "--build-config", "Release", "--output-on-failure"]);
  const suffix = process.platform === "win32" ? ".exe" : "";
  async function binary(directory: string, name: string) {
    for (const path of [
      join(directory, name + suffix),
      join(directory, "Release", name + suffix),
    ]) {
      try {
        await access(path);
        return path;
      } catch {
        /* Try the multi-config generator's output directory. */
      }
    }
    throw new Error(`Missing built CAD test binary: ${name}`);
  }
  await run(
    process.execPath,
    ["--experimental-strip-types", "--test", "--test-concurrency=1", "tests/cad/*.test.ts"],
    {
      ...process.env,
      DAI_CAD_TEST_WORKER: await binary(build, "dai-cad-worker"),
      DAI_CAD_TEST_FIXTURE: await binary(build, "cad-core-tests"),
    },
  );
}
