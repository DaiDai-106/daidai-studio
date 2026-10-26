const schemaError = "工具参数定义不兼容，模型服务拒绝了请求（HTTP 400）。";
const requestError = "模型请求失败，请检查服务配置和认证。";

// Only fixed messages reach history and the UI; provider bodies can contain secrets.
export function modelRequestError(error = ""): string {
  if (error === schemaError || /invalid schema for function|invalid.*tool.*schema/i.test(error))
    return schemaError;
  return requestError;
}
