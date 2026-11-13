/** 无协议域名默认使用 HTTPS，本机带端口地址保留 HTTP 开发入口。 */
export function previewUrl(input: string): URL {
  const value = input.trim();
  if (
    !value ||
    Array.from(input).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("网页地址无效。");
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#]|$)/iu.test(value);
  const target = local
    ? `http://${value}`
    : /^[a-z][a-z0-9+.-]*:/iu.test(value)
      ? value
      : `https://${value}`;
  let url: URL;
  try {
    if (!/^https?:\/\//iu.test(target)) throw new Error();
    url = new URL(target);
  } catch {
    throw new Error("请输入 HTTPS 网页或本机 HTTP 服务地址。");
  }
  if (url.username || url.password) throw new Error("预览地址不能包含用户名或密码。");
  if (url.protocol === "http:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("公网网页请使用 HTTPS；HTTP 仅支持本机回环服务。");
  return url;
}

// HTTPS 网页允许 HTTPS/WSS 跨来源资源；本机与静态页面继续限制在初始来源。
export function allowedPreviewRequest(input: string, origin: URL, navigation = false): boolean {
  try {
    const url = new URL(input);
    if (url.username || url.password) return false;
    if (url.protocol === "blob:") return !navigation && url.origin === origin.origin;
    if (url.protocol === "data:") return !navigation;
    if (origin.protocol === "https:")
      return url.protocol === "https:" || (!navigation && url.protocol === "wss:");
    const protocol = !navigation && url.protocol === "ws:" ? "http:" : url.protocol;
    return protocol === origin.protocol && url.host === origin.host;
  } catch {
    return false;
  }
}

/** 工具栏和事件不泄露 URL 中的查询参数或片段。 */
export function previewDisplayUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
