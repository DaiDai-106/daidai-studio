import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const grammars = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
} as const;

type Language = keyof typeof grammars;
const extensions: Record<string, Language> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  pyi: "python",
  css: "css",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  html: "html",
  htm: "html",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  urdf: "xml",
  xacro: "xml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  toml: "toml",
};

export function languageForPath(path: string): Language | null {
  const filename = path.split("/").pop() ?? "";
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? (extensions[filename.slice(dot + 1).toLowerCase()] ?? null) : null;
}

export function highlightLimitExceeded(content: string): boolean {
  if (content.length > 200_000) return true;
  let lineCount = 1;
  let lineLength = 0;
  for (const character of content) {
    if (character === "\n") {
      lineCount++;
      lineLength = 0;
    } else {
      lineLength++;
    }
    if (lineCount > 5000 || lineLength > 10_000) return true;
  }
  return false;
}

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
const loading = new Map<Language, Promise<void>>();

/** 共用高亮器并按需加载已打包的语法；未支持的文件由调用方显示纯文本。 */
export async function highlightCode(path: string, code: string, dark: boolean) {
  const language = languageForPath(path);
  if (!language || highlightLimitExceeded(code)) return null;
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/one-light.mjs"), import("shiki/themes/one-dark-pro.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  const instance = await highlighter;
  let pending = loading.get(language);
  if (!pending) {
    pending = instance.loadLanguage(grammars[language]());
    loading.set(language, pending);
  }
  await pending;
  return instance.codeToTokens(code, {
    lang: language,
    theme: dark ? "one-dark-pro" : "one-light",
  }).tokens;
}
