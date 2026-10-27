import type { MessageBlock } from "../../shared/application.ts";

export const TOOL_PREVIEW_LIMIT = 8000;
export const THINKING_PREVIEW_LIMIT = 64_000;
export function preview(text: string, limit = TOOL_PREVIEW_LIMIT) {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

// Keep bounded display arguments separate from the actual arguments sent to tools.
export function displayArguments(args: Record<string, unknown> | undefined) {
  if (!args) return {};
  let truncated = false;
  let remaining = 16_000;
  let entriesLeft = 500;
  const secrets = new Set([
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "credentials",
  ]);
  function visit(value: unknown, depth: number): unknown {
    if (--entriesLeft < 0 || remaining <= 0 || depth > 6) {
      truncated = true;
      return "…";
    }
    if (typeof value === "string") {
      const count = Math.min(4096, remaining);
      remaining -= Math.min(value.length, count);
      if (value.length > count) truncated = true;
      return value.slice(0, count);
    }
    if (Array.isArray(value)) {
      if (value.length > 50) truncated = true;
      return value.slice(0, 50).map((item) => visit(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 50) truncated = true;
      return Object.fromEntries(
        entries
          .slice(0, 50)
          .map(([key, item]) => [
            key,
            secrets.has(key.replace(/[_-]/g, "").toLowerCase())
              ? "[已隐藏]"
              : visit(item, depth + 1),
          ]),
      );
    }
    return value;
  }
  return { args: visit(args, 0) as Record<string, unknown>, argsTruncated: truncated };
}

export function publicBlock(block: {
  type: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
}): MessageBlock | null {
  if (block.type === "text") return { kind: "text", text: block.text ?? "" };
  if (block.type !== "thinking" || block.redacted) return null;
  const value = preview(block.thinking ?? "", THINKING_PREVIEW_LIMIT);
  return { kind: "thinking", ...value };
}

export function toolPhase(details: unknown): string {
  if (
    !details ||
    typeof details !== "object" ||
    !("phase" in details) ||
    typeof details.phase !== "string"
  )
    return "";
  return details.phase.slice(0, 200);
}

export function toolIdentity(details: unknown): { displayName?: string; serverName?: string } {
  if (
    !details ||
    typeof details !== "object" ||
    !("toolName" in details) ||
    !("serverName" in details) ||
    typeof details.toolName !== "string" ||
    typeof details.serverName !== "string"
  )
    return {};
  return {
    displayName: details.toolName.slice(0, 200),
    serverName: details.serverName.slice(0, 200),
  };
}
