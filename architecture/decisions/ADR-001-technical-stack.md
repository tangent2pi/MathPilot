# ADR-001：技术栈 — TypeScript monorepo + Python 算法侧车

- 状态：已接受
- 日期：2026-08-17
- 依据：`design-docs/进一步实施规划v1-契约与模块组装.md` 一级决策 1、2、4、5

## 背景

实施规划 v1 冻结了前后端分离、PostgreSQL 唯一事实源、Pi Agent Harness、Provider 契约等决策，但没有冻结实现语言。候选方向存在一个矛盾：Pi SDK、浏览器前端与 API 生态以 TypeScript 为主；pyBKT、队友 TEACHER OCR 管线是 Python。

## 决策

1. 主技术栈为 **TypeScript monorepo**（pnpm workspace）：
   - `services/*` 与 `apps/*`、`packages/*` 全部使用 TypeScript。
   - 模块间只通过已冻结的 JSON Schema / ESM 类型 / Provider 契约交流。
2. **Python 只作为算法与媒体侧车**：
   - BKT/保持率/稳定度内核：Python（可调用 pyBKT）。
   - PaddleOCR/队友 TEACHER 管线：Python Worker。
   - Python 进程不直接读写 PostgreSQL 业务表；通过 HTTP/RPC 接口或事务队列消息由 TS 宿主调用，输出符合 schema 的结构化结果。
3. 不能引入混合语言边界决策：
   - Python 侧车只能作为 `packages/providers/*` 或 `services/agent-runtime` 的一个 Provider 实现被替换；
   - Python 侧车不持有前端契约、不定义领域 Schema、不拥有长期状态。

## 后果

- 前后端共享同一套生成类型（ui-sdk），无双语言漂移。
- 算法侧保持 pyBKT/OCR 生态，但调用面极窄，替换代价低。
- monorepo 需要统一的 lint/typecheck/test 命令，所有 packages 至少通过 `tsc --noEmit`。