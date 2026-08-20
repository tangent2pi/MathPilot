export const PIPELINE_TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** 只有明确由时限终止、且尚未进入 ER 的任务才能复用原 KTQ Session。 */
export function shouldResumeTimedOutKtq(stage: string, errorDetail: string | null | undefined): boolean {
  return stage === "ktq" && /(?:pipeline stage exceeded \d+ms|timed?\s*out|timeout|超时)/i.test(errorDetail ?? "");
}
