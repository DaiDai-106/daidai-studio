// 展示用参数经过长度限制与脱敏，不修改实际传给工具的参数。
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
