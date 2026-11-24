const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function vector(line: string | undefined, prefix: string) {
  if (!line?.startsWith(prefix)) return false;
  const values = line.slice(prefix.length).trim().split(/\s+/);
  return (
    values.length === 3 &&
    values.every((value) => number.test(value) && Number.isFinite(Math.fround(Number(value))))
  );
}

export function normalizeStl(data: Buffer): Buffer {
  if (data.length >= 84) {
    const faces = data.readUInt32LE(80);
    if (faces > 0 && 84 + 50 * faces === data.length) {
      for (let start = 84; start < data.length; start += 50) {
        for (let offset = 0; offset < 48; offset += 4) {
          if (!Number.isFinite(data.readFloatLE(start + offset)))
            throw new Error("STL 包含无效坐标。");
        }
      }
      return data;
    }
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(data).trimStart();
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter(Boolean);
  let inside = false;
  let faces = 0;
  for (let index = 0; index < lines.length; ) {
    const line = lines[index++];
    if (!inside && /^solid(?: |$)/.test(line ?? "")) {
      inside = true;
      continue;
    }
    if (inside && /^endsolid(?: |$)/.test(line ?? "")) {
      inside = false;
      continue;
    }
    if (
      !inside ||
      !vector(line, "facet normal ") ||
      lines[index++] !== "outer loop" ||
      !vector(lines[index++], "vertex ") ||
      !vector(lines[index++], "vertex ") ||
      !vector(lines[index++], "vertex ") ||
      lines[index++] !== "endloop" ||
      lines[index++] !== "endfacet"
    )
      throw new Error("STL 网格格式无效。");
    faces++;
  }
  if (inside || !faces) throw new Error("STL 网格格式无效。");
  // Three.js uses the opening solid marker to distinguish ASCII from binary STL.
  const bytes = Buffer.from(text);
  return data.equals(bytes) ? data : bytes;
}
