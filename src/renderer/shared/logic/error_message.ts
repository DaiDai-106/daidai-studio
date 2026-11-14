/** Electron 会给业务异常添加 IPC 包装，界面只展示业务原因。 */
export function errorMessage(error: unknown, fallback = "操作失败，请重试。") {
  if (!(error instanceof Error)) return fallback;
  return (
    error.message.replace(/^(?:Error invoking remote method '[^']+':\s*|Error:\s*)+/, "") ||
    fallback
  );
}
