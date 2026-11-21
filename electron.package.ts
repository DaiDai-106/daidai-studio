import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const target = process.argv[2] ?? "--dir";
const targets = new Map([
  [
    "--dir",
    {
      host: process.platform,
      args:
        process.platform === "darwin"
          ? ["--dir", "--config.mac.identity=-", "--config.mac.forceCodeSigning=false"]
          : ["--dir"],
    },
  ],
  ["--deb", { host: "linux", args: ["--linux", "deb"] }],
  ["--win", { host: "win32", args: ["--win", "nsis"] }],
]);
const selected = targets.get(target);
if (!selected) throw new Error(`Unknown package target: ${target}`);
if (selected.host !== process.platform)
  throw new Error(`Build ${target} on ${selected.host}; current host is ${process.platform}.`);

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
