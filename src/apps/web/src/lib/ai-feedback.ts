import { ApiError } from "./api";

/** 面向所有 AI 会话的错误文案：说明原因、恢复动作，并避免泄露服务端内部细节。 */
export function aiRequestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后再发送。你刚才的内容仍保留在对话中。";
    if (error.status === 403) return "当前账号没有执行这项操作的权限。请切换到有权限的账号后重试。";
    if (error.status === 408 || error.status === 504) return "AI 本次处理超时。内容已经保留，请缩小图片或资料范围后重试。";
    if (error.status === 409 && /(no longer|not accepting|completed|已结束|已完成)/i.test(error.message)) return "这个 AI 会话已经结束，无法继续发送。请返回任务页重新开始或重试任务。";
    if (error.status === 409) return "这个 AI 会话正在处理上一条消息。请等待当前步骤完成后再重试。";
    if (error.status === 413) return "发送的图片或资料过大。请减少文件数量或压缩后重试。";
    if (error.status === 429) return "AI 服务当前请求较多。你的内容已经保留，请稍后重试。";
    if (error.status >= 500) return "AI 服务没有完成这次处理。你的内容已经保留，请稍后重试。";
  }
  if (error instanceof Error && /^请先/.test(error.message)) return error.message;
  return fallback;
}
