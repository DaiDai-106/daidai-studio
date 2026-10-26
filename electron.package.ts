import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const target = process.argv[2] ?? "--dir";
const targets = new Map([
  ["--dir", { host: process.platform, args: ["--dir"] }],
  ["--deb", { host: "linux", args: ["--linux", "deb"] }],
  ["--mac", { host: "darwin", args: ["--mac", "dmg"] }],
  ["--win", { host: "win32", args: ["--win", "nsis"] }],
]);
const selected = targets.get(target);
if (!selected) throw new Error(`Unknown package target: ${target}`);
if (selected.host !== process.platform)
  throw new Error(`Build ${target} on ${selected.host}; current host is ${process.platform}.`);

// Use the tool's CLI and configuration schema; the host owns platform selection only.
const native = spawn(
  process.execPath,
  ["--experimental-strip-types", join(projectRoot, "scripts/native.ts"), "--runtime"],
  { cwd: projectRoot, stdio: "inherit", shell: false },
);
await new Promise<void>((resolve, reject) => {
  native.once("error", reject);
  native.once("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`CAD runtime build failed (${code}).`)),
  );
});
const child = spawn(
  process.execPath,
  [
    join(projectRoot, "node_modules/electron-builder/cli.js"),
    "--config",
    "electron-builder.json",
    "--publish",
    "never",
    ...selected.args,
  ],
  { cwd: projectRoot, stdio: "inherit" },
);
await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Packaging failed (${code}).`));
  });
});
