import { describe, expect, it } from "vitest";
import { aiRequestErrorMessage } from "../lib/ai-feedback";
import { ApiError } from "../lib/api";

describe("AI request feedback", () => {
  it("distinguishes an expired login from an empty AI response", () => {
    expect(aiRequestErrorMessage(new ApiError("Unauthorized", 401, null), "fallback")).toContain("登录状态已失效");
  });

  it("gives a recovery action for overloaded and oversized requests", () => {
    expect(aiRequestErrorMessage(new ApiError("too large", 413, null), "fallback")).toContain("压缩后重试");
    expect(aiRequestErrorMessage(new ApiError("busy", 429, null), "fallback")).toContain("稍后重试");
  });

  it("distinguishes a busy session from a completed session", () => {
    expect(aiRequestErrorMessage(new ApiError("session_busy", 409, null), "fallback")).toContain("上一条消息");
    expect(aiRequestErrorMessage(new ApiError("session no longer accepting messages", 409, null), "fallback")).toContain("已经结束");
  });

  it("keeps local validation details and uses the supplied fallback otherwise", () => {
    expect(aiRequestErrorMessage(new Error("请先写下解题步骤。"), "fallback")).toBe("请先写下解题步骤。");
    expect(aiRequestErrorMessage(new Error("network"), "请检查网络后重试。")).toBe("请检查网络后重试。");
  });
});
