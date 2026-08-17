# ADR-004：教学与画像的写权限与更新路径隔离

- 状态：已接受
- 日期：2026-08-17
- 依据：`系统设计v3.3` §1.1、§2.1、§9、§11；`进一步实施规划v1` 一级决策 8、9

## 背景

设计宪法要求：教学模型负责判答/教学/单题观察但不能直接改长期画像；传统程序只提供科学基准；长期画像只由 Dream 大模型更新。这条隔离是系统可信度的核心。

## 决策

1. Teaching Agent 对画像只有只读投影视图；其写范围严格限定为当前 Session 输出（判答、消息、`TeachingSessionSummary`）。
2. 每个教学 Session 关闭时强制同时产出：
   - `ScientificEvaluationReport`（确定性程序）；
   - `TeachingSessionSummary`（Teaching Agent）；
   - 二者成对封装为 `SessionLearningRecord`，缺少任意一项或 session_id 不一致不得进入 Dream 队列。
3. `StudentSnapshot` 只由通过校验的 `ProfileUpdateDecision` 幂等物化（Dream 路径）；程序评价器与 Teaching Agent 均无写快照权限。
4. Dream/Profile Update Agent 必须是全新的独立 LLM Session：不继承 Teaching Agent 模型历史，只接收 `ProfileEvidenceBundle`（双产物 + 按需展开的授权证据索引）。
5. Decision Validator 只做引用/边界/算术/去重检查，禁止静默替换为大模型未声明的基准值。
6. 教师纠正走 supersede + 状态重放，禁止以修改权重方式追加观测。

## 后果

- 任何违反上述写路径的实现都在契约测试中失败（测试用具注入越权写入尝试）。
- 系统存在 `profile_lag`：Dream 未完成时教学继续使用旧快照 + 最新 handoff。