/** 只识别光标前未完成的 @ 词；完整引用仍由共享解析器处理。 */
export function fileMention(text: string, caret: number) {
  const match = /(?:^|\s)@([^\s@"，。；]*)$/u.exec(text.slice(0, caret));
  if (!match || (match[1]?.length ?? 0) > 200) return null;
  return {
    start: caret - (match[1]?.length ?? 0) - 1,
    end: caret + (/^[^\s@"，。；]*/u.exec(text.slice(caret))?.[0].length ?? 0),
    query: match[1] ?? "",
  };
}
