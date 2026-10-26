import { writeFile } from "node:fs/promises";

const ready = process.argv[2],
  closed = process.argv[3];
if (!ready || !closed) throw new Error("Markers required.");
const closedMarker = closed;
let closing: Promise<void> | undefined;
function close() {
  closing ??= writeFile(closedMarker, "closed");
  void closing.then(() => process.exit(0));
}
process.stdin.resume();
process.stdin.once("end", close);
process.once("SIGTERM", close);
await writeFile(ready, "ready");
