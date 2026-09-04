"use client";

// 当前对话线程 id 上下文：assistant.tsx 从路由 /c/:threadId 解析后注入，
// composer 内的自我测评入口据此把报告落到当前对话消息流。
import { createContext, useContext } from "react";

const LearningThreadContext = createContext<string | undefined>(undefined);

export const LearningThreadProvider = LearningThreadContext.Provider;

export function useLearningThreadId(): string | undefined {
  return useContext(LearningThreadContext);
}
