import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type CadResponse,
  type CadToolName,
  validateCadInput,
  validateCadOutput,
} from "./contract.ts";
import type { WorkerConfig } from "./types.ts";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort(): void;
};

// Only this adapter knows the private worker framing. The external protocol is MCP.
export class CadWorker {
  readonly stagingRoot: string;
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private output = Buffer.alloc(0);
  private exited = false;
  private closing = false;
  private closed: Promise<void> | undefined;
  private failure = new Error("Native worker exited.");
  private exit: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, stagingRoot: string) {
    this.child = child;
    this.stagingRoot = stagingRoot;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // Drain native diagnostics; filenames or parser details must not enter model replies.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.terminate(new Error("Native worker input disconnected.")));
    child.on("error", () => this.terminate(new Error("Cannot start Native worker.")));
    this.exit = new Promise<void>((resolve) => {
      child.once("close", () => {
        this.exited = true;
        for (const [id, request] of this.pending) {
          this.clear(id, request);
          request.reject(this.failure);
        }
        resolve();
      });
    });
  }
  static async start(options: WorkerConfig) {
    if (!options.executable || !isAbsolute(options.executable))
      throw new Error("Native executable must be an absolute path.");
    await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(join(await realpath(options.stagingRoot), "worker-"));
    const config = join(stagingRoot, "worker.json");
    try {
      await writeFile(
        config,
        JSON.stringify({
          ...(options.projectRoot ? { projectRoot: await realpath(options.projectRoot) } : {}),
          stagingRoot,
          outputRoot: options.outputRoot,
          limits: options.limits ?? {},
        }),
        { mode: 0o600 },
      );
      const args = ["--config", config];
      const child = spawn(options.executable, args, {
        cwd: stagingRoot,
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      });
      return new CadWorker(child, stagingRoot);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }
  private clear(id: string, request: Pending) {
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    this.pending.delete(id);
  }
  private receive(chunk: Buffer) {
    this.output = Buffer.concat([this.output, chunk]);
    let end = this.output.indexOf(10);
    while (end >= 0) {
      const line = this.output.subarray(0, end);
      this.output = this.output.subarray(end + 1);
      if (line.length > 1_100_000)
        return this.terminate(new Error("Native response exceeds the frame limit."));
      try {
        const frame: unknown = JSON.parse(line.toString("utf8"));
        if (
          !frame ||
          typeof frame !== "object" ||
          !("requestId" in frame) ||
          typeof frame.requestId !== "string" ||
          !("result" in frame)
        )
          throw new Error("Invalid Native frame.");
        const request = this.pending.get(frame.requestId);
        if (!request) throw new Error("Unexpected Native response.");
        // Validation may throw; leave the request owned until the result is accepted.
        request.resolve(frame.result);
        this.clear(frame.requestId, request);
      } catch {
        return this.terminate(
          new Error("Native worker response violates the application contract."),
        );
      }
      end = this.output.indexOf(10);
    }
    if (this.output.length > 1_100_000)
      this.terminate(new Error("Native response exceeds the frame limit."));
  }
  private terminate(error: Error) {
    this.failure = error;
    if (!this.exited) this.child.kill("SIGKILL");
  }
  request<K extends CadToolName>(
    tool: K,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CadResponse<K>> {
    validateCadInput(tool, input);
    if (this.closing || this.exited) return Promise.reject(this.failure);
    if (this.pending.size >= 32)
      return Promise.reject(new Error("Too many pending Native requests."));
    if (signal?.aborted) return Promise.reject(new Error("Native request cancelled."));
    const id = randomUUID();
    const line = `${JSON.stringify({ requestId: id, tool, input })}\n`;
    if (Buffer.byteLength(line) >= 65535)
      return Promise.reject(new Error("Native request is too large."));
    return new Promise((resolve, reject) => {
      const abort = () => this.child.stdin.write(`${JSON.stringify({ cancelRequestId: id })}\n`);
      const timer = setTimeout(
        () =>
          this.terminate(
            new Error("Native worker request timed out; its handles are no longer valid."),
          ),
        30_000,
      );
      this.pending.set(id, {
        resolve: (value) => {
          validateCadOutput(tool, value);
          resolve(value);
        },
        reject,
        ...(signal ? { signal } : {}),
        abort,
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(line);
    });
  }
  close() {
    this.closed ??= this.shutdown();
    return this.closed;
  }
  private async shutdown() {
    this.closing = true;
    this.child.stdin.end();
    const deadline = setTimeout(
      () => this.terminate(new Error("Native worker shutdown timed out.")),
      5_000,
    );
    try {
      await this.exit;
    } finally {
      clearTimeout(deadline);
      await rm(this.stagingRoot, { recursive: true, force: true });
    }
  }
}
