# 对话层重写蓝图 v1：线程模型与 fork 流水线

- 状态：P1 原型已实施并通过类型检查与生产构建；P2–P4 待实施。
- 日期：2026-08-29
- 依据：`docs/assistant-ui-集成调研与决断.md`（调研与决断全记录）；`系统设计v3.3` §10（两阶段选题）、§11.2（Session 关闭后流程）、§对象存储；`架构修订v4`；Pi SDK 0.84.1 源码验证
- 项目阶段：原型。原则：完整工程化重写，不考虑兼容性，不为旧客户端保留兼容

## 一、架构总览

```
┌─ 前端（React 19 + Vite，新增 Tailwind）──────────────────────────────┐
│  apps/web 重构：usePiRuntime + 官方 Thread/Composer + interactables   │
│  ├─ SolvePage → 线程对话页（题面开场白气泡 + chat + 卡片）             │
│  ├─ 线程列表 = 题列表（历史题切换 = 切线程）                           │
│  ├─ "下一题"动作 → 前端切视图 + 后台链                                │
│  └─ 自定义渲染：题面开场白、教学卡片（interactable）、Markdown+KaTeX   │
└──────────────┬───────────────────────────────────────────────────────┘
               │ /api/pi/*（HTTP/SSE）+ 业务端点（cookie 鉴权 + RLS）
┌──────────────▼───────────────────────────────────────────────────────┐
│ api 网关（Better Auth）                                               │
│  ├─ /api/pi/* → 转发 agent-runtime（鉴权：assertSessionOwner 模式）    │
│  └─ /api/learning/* → 后台链触发、选题、卡片事件审计、SLR 查询          │
└──────┬───────────────────────────────┬──────────────────────────────┘
       │                                │
┌──────▼───────────────┐   ┌───────────▼──────────────────────────────┐
│ agent-runtime        │   │ learning 服务（后台处理引擎，无状态机）     │
│  PiThreadSupervisor  │   │  后台链（§11.2 七步，串行）：               │
│  进程单例，每线程一   │   │  校验 → 正式判答(模型) → SER(程序) →       │
│  AgentSession        │   │  TSS(模型) → SLR 入库 → Dream 队列+handoff │
│  线程=Pi 会话文件     │   │  → 选题(§10.1) → 建题 N+1 session          │
│  forkFrom 支持        │   │                                            │
└──────┬───────────────┘   └───────────┬──────────────────────────────┘
       │                               │
┌──────▼───────────────────────────────▼──────────────────────────────┐
│ 存储：Postgres（RLS、SLR/快照/handoff/选题元数据）+ MinIO（产物、     │
│       Session 归档包；元数据+哈希在 Postgres）+ 执行工作区（可回收）    │
└──────────────────────────────────────────────────────────────────────┘
```

## 二、线程与会话模型（核心）

- **一题一 session（thread）**：一个学生一个线程列表，线程 = 题。线程即会话真相（Pi 会话文件），业务无状态机。
- **题面**：新 session 创建后，题面作为**第一条 agent 消息（开场白气泡）**显示（内容来自内容库，即时可显示）。不是独立题卡区域。
- **正常 chat**：教学回合像 ChatGPT——模型直接问/答/出卡片（interactables）；判答在对话内自然完成（模型按 rubric 判定）。
- **"下一题"**：前端立即进入题 N+1 视图（题面气泡可先显示）→ 后台链（下）→ session 就绪 → 用户可聊；若后台链未完成用户已发消息，显示"准备中"（消息排队）。
- **回看历史题**：切线程即可（react-pi 线程列表 + 冷快照恢复），随时继续聊。
- **系统提示词注入**：创建 session 时 `buildSystemPrompt({ customPrompt（整体替换）, appendSystemPrompt, promptGuidelines, contextFiles, skills, cwd })`——程序拼：题目、教学目标、上一 Dream 快照 + handoff、任务策略（teach-interact 等）。
- **fork**：`SessionManager.forkFrom` 复制会话文件（字节级一致）；后台链在 fork 副本上跑，主线程不受影响。

## 三、工作区与存储

- **执行工作区**（可回收）：每线程一目录 `/runtime/workspaces/<student>/<threadId>/`；fork 副本共享主线程工作区（targetCwd 同一目录，仅会话文件独立）；**草稿/上传图仅对应线程使用**，不跨线程共享。
- **长时留存**（不可回收）：产物发布器（已实现）→ **MinIO**（`mathpilot.learning-artifact/v1` manifest、产物文件、Session 归档包）；元数据与哈希在 Postgres。执行工作区生命周期结束即归档打包。
- 演进：bubblewrap 进程级沙箱（现状）→ 容器 → microVM，持久化通道不变。

## 四、fork 后台链（§11.2 七步，串行）

触发：用户点"下一题"。fork 副本（隐藏线程）上执行：

```
① 校验 Session 输出与所有引用（程序）
② 正式判答回合（模型，fork 副本 followUp 注入）
    注入消息说明身份切换："你已从教学对话切换为判答任务…"
    产出：候选 AnswerJudgment + 单题 StateObservation（校验器核对 Schema/引用/测量规则）
③ 确定性程序：ScientificEvaluationReport（pyBKT 等，读 Session 事件）
④ 教学总结回合（模型：读 SER + Session 证据 → TeachingSessionSummary）
⑤ 校验 session_id/来源/版本/相互引用 → SessionLearningRecord 入库
⑥ 双产物入 Dream 队列 + 生成下一题短期 handoff.md
⑦ 长期 StudentSnapshot 不动（Dream 批处理触发：日终/阈值/矛盾/教师请求/摘要过长）
→ 选题（§10.1 两阶段：目标选择 7 类 → 硬过滤 + 8 项评分；输入=上一 Dream 快照+handoff）
→ 创建题 N+1 session（buildSystemPrompt 注入 handoff+状态，题面作开场白气泡）→ 就绪
```

**注入纪律（缓存保护）**：后台链所有模型调用走 **followUp**（`prompt(text, { streamingBehavior: "followUp" })`），**不修改会话历史中的任何内容、不修改系统提示词**——prompt 前缀与主线程一致 → provider cacheRead 命中，后台处理几乎不费 input token。身份切换与任务指令写在追加消息里。

**并发**：fork 副本与主线程并行（多 AgentSession 实例，PiThreadSupervisor 已证明可行）；模型并发上限暂不设（实施时观察）。

## 五、API 路由层（api 网关）

| 路由 | 说明 |
|---|---|
| `GET/POST /api/pi/*` | react-pi wire contract 全套（threads CRUD、messages、events SSE、cancel、queue/clear、models、model、thinking、archive、host-ui、fs）——转发 agent-runtime，包 Better Auth cookie 鉴权 + 线程↔学生所有权校验（assertSessionOwner 模式）+ RLS |
| `POST /api/learning/next-question` | 点"下一题"：fork 当前线程（隐藏副本）→ 触发后台链 → 后台链完成后选题 → 创建题 N+1 线程 → 返回新线程 ID/题面 |
| `POST /api/learning/questions/:id/card-event` | interactables 卡片事件**审计落库**（interaction_token 校验，不可变事件纪律），不驱动流程 |
| `GET /api/learning/threads` | 线程列表（= 题列表）+ 每题状态（进行中/后台处理中/已归档） |
| `GET /api/learning/slr/:threadId` | SLR/判定查询（教师复核、报告页） |

SSE 鉴权：复用现有 `/agent-events` 的 hijack + close 模式（cookie 头校验）。

## 六、前端设计

**页面重构**（旧轮询客户端不保留）：
- `SolvePage` → 线程对话页（默认线程 = 当前题；题面开场白气泡 + chat + 卡片 + 下一题按钮）
- `AgentSessionPage`/`ContentPage` 轮询 → 并入线程模型或按新信息架构重做
- `AskPage` → 升级为独立提问线程（无后台链）或保留占位

**组件映射**：

| 现有（手写） | 新（assistant-ui） |
|---|---|
| `MessageRow`/`chatbox-message` | 官方 `Message` 组件 + 自定义渲染 |
| `MathText`（KaTeX auto-render） | markdown 组件（react-markdown）+ 组件映射接 KaTeX（`$...$` 渲染数学）——全站统一 |
| `ThinkingPanel`（details+pre） | 流式消息（message_update 保真）+ 工具卡片（Tool UI） |
| `NativeArtifactCard`（题卡） | interactable 工具渲染（`unstable_interactableTool`，with-artifacts 同款机制） |
| `ArtifactCard`（教学演示 iframe） | interactable 工作台（Trigger 卡片 + 预览/版本）+ postMessage 协议保留（interaction_token） |
| 追问/判定（verdict 状态机） | 对话内自然消息（模型直接问/答）+ 后台链正式产物（SLR） |
| 状态机（CREATE/GRADE/…） | 退役——线程状态（react-pi）+ 后台链任务状态 |

**卡片双通道**：interactables（前端交互状态，进对话转录）+ `/card-event`（服务端校验+审计落库）。

**样式**：引入 Tailwind（对话区域先行，全站渐进迁移）。

## 七、存储与数据

- Postgres：线程↔学生映射、SLR、快照、handoff、选题记录、审计事件——保持 RLS/不可变事件纪律
- MinIO：学习产物（manifest 校验后发布）、Session 归档包（执行工作区归档）
- 执行工作区：可回收，不视为持久数据

## 八、实施阶段

- **P1 基础重写**：前端引入 assistant-ui + Tailwind（对话区域）；api 网关加 `/api/pi/*` 转发与鉴权；agent-runtime 接 PiThreadSupervisor（事件保真：message_update 不丢不截）；SolvePage 改线程对话页（题面开场白、chat、流式）
- **P2 fork 流水线**：点"下一题"→ fork + 后台链（校验/正式判答/SER/TSS/SLR/Dream 队列/handoff）+ 题 N+1 就绪 + "准备中"排队
- **P3 卡片与产物**：interactables 题卡/教学演示迁移 + MinIO 发布/归档 + /card-event 审计 + 线程列表（历史题回看）
- **P4 选题器与闭环**：§10.1 两阶段选题器实现（目标选择 + 硬过滤 + 评分）+ Dream 集成 + 教师复核（supersede+重放）对接新模型

## 九、风险与注意

- Pi 事件保真是全部体验的地基：`normalizeEvent` 退役，message_update 全量投影（打字机）；前端性能靠流式组件虚拟化
- fork 缓存命中的前提纪律：fork 后立即处理、模型/参数不变、后台链不改历史不改 system prompt
- 后台链串行时长 = "准备中"等待上限；§10.2 终止条件与疲劳保护仍适用
- 教师复核（review 服务）改从 SLR/线程转录读取，supersede+重放语义不变
