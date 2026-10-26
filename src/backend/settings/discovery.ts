import type { ModelChoice } from "../../shared/application.ts";

// Only OpenAI-compatible servers need this adapter; built-in catalogues use pi-ai.
export async function discoverModels(endpoint: string, apiKey?: string): Promise<ModelChoice[]> {
  let data: unknown;
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4 * 1024 * 1024) throw new Error();
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Never expose response bodies: some services echo authorization headers.
    throw new Error("模型目录读取失败或响应过大，请检查服务地址、认证，或手动填写模型 ID。");
  }
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data))
    throw new Error("服务未返回有效模型目录，可手动填写模型 ID。");
  const ids = new Set<string>();
  for (const item of data.data.slice(0, 1000))
    if (
      item &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      item.id.length <= 200
    )
      ids.add(item.id);
  return [...ids].map((id) => ({
    id,
    name: id,
    context: 131072,
    output: 8192,
    reasoning: "参数未验证",
  }));
}
