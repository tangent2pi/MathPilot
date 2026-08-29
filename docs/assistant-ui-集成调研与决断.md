# assistant-ui 集成调研与决断

- 状态：P1 原型已实施并通过类型检查与生产构建；P2–P4 仍待实施。
- 日期：2026-08-29（2026-08-29 更新：用户确认项目处原型阶段，**不考虑兼容性**，以完整工程化方式重写，推翻"两步走"第一步）
- 范围：前端对话层重构的前置调研；官方文档已落地 `references/assistant-ui/`

## 一、内容记录（调研事实）

### 1.1 当前对话实现的缺陷（代码事实）

| 缺陷 | 位置 | 后果 |
|---|---|---|
| 无真流式：`EventSource` 订阅的 `/api/sessions/:id/agent-events` 实为每 1 秒轮询 trace、有变化才发事件的 120s 长连接包装 | `src/services/api/src/index.ts:319` | 无打字机效果，只有"思考过程"增量 |
| 无 Markdown 管线：消息仅经 `MathText`（KaTeX auto-render 全元素扫描）渲染，`#`/表格/列表/代码块全部丢失 | `src/apps/web/src/components/MathText.tsx`（25 行） | LLM 输出结构不可读 |
| 对话页全手写：约 20 个 useState 的状态机 | `src/apps/web/src/pages/SolvePage.tsx`（369 行）、`AgentSessionPage.tsx`（128 行） | 每页复制一套 |
| 工具事件以 `<details>+<pre>` 呈现 | `AgentSessionPage.tsx:116`、`SolvePage.tsx` ThinkingPanel | 工具调用展示简陋 |
| 两套刷新机制并存 | SolvePage 用 EventSource；AgentSessionPage/ContentPage 用 react-query `refetchInterval` | 不一致 |

后端事件模型（集成需要对齐的事实）：

- `RuntimeAgentEvent`（`src/services/agent-runtime/src/runtime.ts:164`）：`{ seq, at, taskType, type, label, status, detail?, toolName?, usage? }`，type 枚举：`agent_start | turn_start | model_update | assistant_message | tool_start | tool_end | turn_end | agent_end | session_end | retry | context_guard`
- `normalizeEvent`（runtime.ts:191）从 Pi `AgentSessionEvent` 降维：`message_update` 故意丢弃（不暴露私有思维）、`message_end` 截 4000 字符
- 前端通过 `/agent-trace` 拿 `Trace = { steps: TraceStep[], conversation: TraceConversation[] }`

领域交互（assistant-ui 需以自定义消息类型承载，组件逻辑保留）：

- 判定：`/submit` → `VerdictData.judgment` → 一条带 label 的文本消息（"判读完成/本题完成/继续确认"）
- 追问：`verdict.probe.question` → 手写 `native-teaching-card`（textarea + 提交/跳过）→ `/probe`、`/probe-skip`
- 题卡：`question_card` artifact → `NativeArtifactCard`（单选/多选/填空/判断）→ `/card-event` + `/interact(action=card_event)`
- 教学演示：`html` artifact → `iframe sandbox="allow-scripts"` + postMessage 协议（`interaction_token` 校验，三事件）

### 1.2 许可证（已核实）

- assistant-ui：**MIT**（Copyright 2025 AgentbaseAI Inc.），11.9k stars，2026-08-29 仍有提交，未归档；Tool UI 亦 MIT
- 依赖链路（shadcn/ui、Radix、react-markdown 等）均宽松许可；唯一商业部分是云端托管 Assistant Cloud，自托管不涉及

### 1.3 官网与 Examples（已实地抓取验证）

- 文档导航：primitives / runtimes / tools / guides / integrations / api-reference / design / tap
- **版本信号**：当前 API 已演进到 elements 体系（`AuiProvider`、`useAui()`、`AuiConfig`、`thread.aui` 组件），旧版 `useDataStreamRuntime` 仍在但已非主推——实施时必须按落地文档的最新 API
- `/examples` 画廊 16 个精选：ai-sdk、artifacts、chatgpt、claude、expo、fastapi-langgraph、form-demo、gemini、generative-ui、grok、interactables、mastra-ui-dojo、mem0、modal、perplexity、stockbroker
- 对 MathPilot 最相关：
  - **artifacts**（`examples/with-artifacts`）：沙箱 iframe 实时预览模型生成物——与现有"教学演示"同模式，成熟实现可对照
  - **modal**（`AssistantModalPrimitive` Root/Anchor/Trigger/Content）：悬浮 copilot，可升级 AskPage（现 5 行占位）
  - **with-external-store**：`useExternalStoreRuntime({ messages, setMessages, onNew, convertMessage })`——消息状态自管，`onNew` 可接任意自定义后端（原型阶段已放弃此路径）
  - **with-pi**（2026-08-29 深入源码，见 `references/assistant-ui/packages/react-pi/`）：官方 `@assistant-ui/react-pi` 适配器。链路：浏览器 `createPiHttpClient`（PiClient 契约的 HTTP/SSE 实现，14 端点 wire contract + snapshot/seq 增量 SSE）→ `usePiRuntime` → 服务端 `createPiNodeClient` → `PiThreadSupervisor`（进程单例，Pi 单活动会话→多线程视图，thread=Pi 会话文件）→ `@earendil-works/pi-coding-agent`。要点：message_update 流式投影（打字机）、toolResult 按 toolCallId 配对、断线重连+快照回放、浏览器断开≠中止、主机 UI（extension_ui_request → approval/interrupt 工具卡）。与 agent-runtime 同源（同一 Pi SDK、同一 AgentSessionEvent），但会话模型/事件保真/鉴权/业务协议四处不兼容——原型阶段重写以它为蓝本。

## 二、决断

1. **引入 assistant-ui 作为对话层组件基础**（MIT，无许可障碍），接管：气泡渲染、markdown+KaTeX 管线、工具调用卡片、流式状态机。
2. **项目处原型阶段 → 完整工程化重写，不考虑兼容性。** 采用以 with-pi 为蓝本的完整链路（`usePiRuntime` + `PiThreadSupervisor`），重写对话执行层。
3. **会话模型（2026-08-29 用户定案，替代"业务状态机权威"）**：**线程即会话真相，learning 服务只产"额外产物"，全流程无复杂状态机**：
   - 一个学生 ↔ 一个 Pi 会话（thread），所有题在同一个会话里正常 chat（像 ChatGPT）
   - 新题开始 = **程序拼接系统提示词**（题目/教学目标/短画像）注入线程
   - 用户点"下一题" = 前端视觉切换（像切换到下一个对话）+ **fork 当前会话到后台**做判答/总结/归档
   - 后台 fork 线程不可见；**旧会话不受影响，可回去继续聊**（react-pi 线程列表天然支持）
   - 判答/追问自然化为对话内容（模型直接问，学生直接答），不再有 verdict/probe 状态机
   - **Pi 原生 fork 验证通过**（SDK 0.84.1，agent-runtime 已用同版本）：`SessionManager.forkFrom(sourcePath, targetCwd)` 带完整历史、`SessionInfo.parentSessionPath` 记录父链、`getTree/getBranch/getLeafId` 会话树、`SessionBeforeForkEvent`；PiThreadSupervisor 已证明多 AgentSession 并行可行
   - learning 服务退化为后台处理引擎：fork 转录 → 程序判答（pyBKT SER）+ 教学总结（fork 上跑总结回合）+ SLR 归档 + Dream 队列——全部是"额外产物"，不驱动前端流程
4. **卡片实现（2026-08-29 用户定案）**：**generative UI / interactables**（`unstable_interactableTool` + `unstable_useInteractable`，with-artifacts 同款机制），而非自定义消息类型：
   - edu-agent 是自 qwen-mm-plugins 提取的教学 skill（`$qwen-mm-plugins-edu-agent`），其产物体系（`mathpilot.learning-artifact/v1`、`question_card`/`knowledge_visualization`/`mixed_lesson`、native_card/sandboxed_html/media 渲染器）与 interactables 结合：模型把卡片定义为 interactable 工具，前端渲染 `NativeArtifactCard`/教学演示组件，状态双向同步（写作中/版本/用户交互）
   - 服务端校验（interaction_token + /card-event 证据链）与 interactables 结合：卡片交互 = 对话消息（进转录），审计事件仍发服务端
5. **四个必需改造点**（react-pi 与现状的差距）：
   - **会话模型**（2026-08-29 澄清）：react-pi 假设 thread = Pi 会话文件（磁盘消息累积、running/idle 两态、用户直连）；我们的业务 Session 是 DB 状态机（CREATE→SUBMIT→GRADE→SCIENTIFIC_EVALUATE→TEACHING_SESSION_SUMMARY→CLOSE→QUEUE_DREAM + DIAGNOSE/PROBE_AWAIT、state_history 审计、SLR 双产物完整性校验），一次业务会话横跨多个 Pi 回合 + 确定性判答 + 独立总结回合。**不兼容本质**：会话事实源不同（磁盘文件 vs DB 状态机）、生命周期不同频（两态 vs 阶段化）、驱动方向不同（用户直连 vs learning 编排）。**解决**：Pi 线程 = 业务会话的执行内核（一业务会话一线程），业务状态机仍是 DB 权威，learning 只做编排/校验/归档；对话执行层改为线程宿主直连。
   - **事件保真**：完整事件流，不得丢弃 `message_update`、不得截断（打字机效果与语义完整的前提）；`normalizeEvent` 的丢弃/截断是语义偏移，退役。事件持久化保留（审计/回放/重连），但投影给前端的是完整流。
   - **鉴权与多租户**（2026-08-29 源码级研究结论）：**assistant-ui 库本身无任何鉴权机制**（core 源码无 auth 实现；`createPiHttpClient.headers` 只是透传通道）；鉴权只在 Assistant Cloud（workspace 授权 + Clerk 等集成），自托管 = 鉴权完全自建。方案：`/api/pi/*` 路由层 = Better Auth cookie + assertSessionOwner/assertWorkspaceOwner + RLS（与 Cloud 的 workspace 模型同构，thread↔学生映射即 workspace 分配）；SSE 路由同样鉴权（复用现有 hijack+close 模式）；前端 cookie 自动携带。
   - **业务协议**（2026-08-29 细讲）：现状业务协议**已是 Pi 提示词协议**——interact(stuck/check_step/method_hint/free_text)/probe/card_event → runTask(teach-interact) → session.prompt(动作+上下文)，submit 先确定性判答（pyBKT SER）再教学回合，教师引导在**同一 AgentSession 续跑**（runtime.ts:626 guidance 机制），respond 工具是结构化出口（reply/status/artifacts，判答/闭合由服务端做）。**重写映射**："对话走线程、语义归服务"——① 自由对话 → usePiRuntime 原生 sendMessage（淘汰 interact 的 runTask 桥）；② 业务动作（submit/probe/card-event）→ 仍走业务 API，learning 校验后把事实作为系统引导注入线程续跑；③ 回合结束 → learning 订阅线程事件流，从完整转录提取 respond 输出 → 程序判答 + 闭合 + SLR 归档（线程转录 = TSS 素材源）；④ 判定/追问/题卡 → 自定义消息类型（业务 API 响应驱动，非 Pi 消息投影）。
5. **领域交互不外包**：判定、追问、题卡、教学演示 iframe 做成 assistant-ui 自定义消息类型，组件逻辑保留（复刻/迁移 `NativeArtifactCard`、postMessage 协议）。
6. **markdown 管线**：assistant-ui markdown 组件映射中接现有 KaTeX（`MathText` 的 auto-render 逻辑收敛为组件内部渲染器，全站统一不丢）。
7. **样式**：引入 Tailwind（assistant-ui 组件体系前置）；现有 `styles/react.css` 逐步迁移或共存。

## 三、细化设计（2026-08-29 用户定案后的落实）

**工作区（2026-08-29 二轮）**：目录策略 ≠ 资源开销（每线程目录只占 KB 级路径元数据；用户量大的真实成本是并发模型回合，不是目录数）。**执行与存储分离**是主线：执行工作区（短暂、可回收）只放运行期文件（会话 JSONL、产物草稿、输入副本）；**长时留存走发布器 + 对象存储**（设计文档 §对象存储已规划：原始文档/笔迹/渲染图/Session 归档包 → 对象存储，元数据+哈希在 PostgreSQL；产物发布器已实现）。原型期保持每线程一目录（fork 共享工作区），未来规模化演进路径对齐企业方案：bubblewrap 进程级沙箱（现状，最轻）→ 需更强隔离时容器（Daytona 模式）→ 硬件级 microVM（E2B Firecracker ~5MiB/会话）；持久化通道不变（发布器+对象存储），换沙箱后端不动持久化。企业参考：每会话沙箱是主流（E2B/Cloudflare microVM+Isolate/Fly Sprites/Modal），非每用户；文件靠 R2 快照/持久卷，空闲冻结计费停。

**系统提示词注入（Pi 实现，已源码验证 0.84.1，2026-08-29 用户定案）**：
- **一题一 session**，创建时走 `buildSystemPrompt({ customPrompt(整体替换), appendSystemPrompt, promptGuidelines, contextFiles, skills, cwd })`——程序拼题目/目标/handoff/画像/任务策略
- 后台链在 fork 副本上走 **followUp 注入**（`prompt(text, { streamingBehavior: "followUp" })`）——**不修改会话历史中的任何内容和系统提示词**（保护 prompt 缓存），指令以追加消息的形式说明"身份切换与后续工作"（从教学对话切换为判答/总结任务）
- 流式排队：`sendUserMessage(content, { deliverAs: "steer"|"followUp" })` + `clearQueue()`；asides（随下一条用户消息带上的上下文）留作需要时用

**题面呈现（2026-08-29 用户定案）**：题面不是独立题卡区域，而是**新会话的第一条消息（agent 开场白气泡）**，像 ChatGPT 开场白——内容来自内容库可即时显示；若后台链未完成时用户发消息，聊天区显示"准备中"（消息排队，session 就绪后进入模型）。

**后台处理链（2026-08-29 按设计文档 §11.2 修正）**：判答分两层——对话内即时判定（教学回合）+ 后台正式判答。fork 副本上的权威串行链（"每个 Session 关闭后"）：
1. 校验 Session 输出与所有引用（程序）
2. **正式判答回合**（模型，fork 副本 followUp：候选 AnswerJudgment + 单题 StateObservation，校验器核对 Schema/引用/测量规则）
3. **确定性程序**：ScientificEvaluationReport（pyBKT 等，读 Session 事件）
4. **教学总结回合**（模型：读 SER + Session 证据 → TeachingSessionSummary）
5. 校验 session_id/来源/版本/相互引用 → SessionLearningRecord 入库
6. 双产物入 **Dream 队列** + 生成下一题短期 **handoff.md**（此即"下一题短期上下文"，非独立递归摘要步骤）
7. 长期 StudentSnapshot 暂不变（Dream 批处理触发：日终/阈值/矛盾/教师请求/摘要过长，非每题）
→ 选题（§10.1 两阶段，用「上一 Dream 快照 + handoff」）→ 创建题 N+1 session（buildSystemPrompt 注入 handoff+状态，题面作开场白气泡）

**fork 字节级一致**：`SessionManager.forkFrom` = 会话文件复制（带完整历史），字节级一致天然成立；后台链模型请求前缀=主线程已聊内容 → provider prompt cache 命中（cacheRead），后台处理几乎不费 input token。前提：fork 后立即处理、模型/参数不变、**不修改会话历史与系统提示词**（followUp 追加消息即满足）。

**interactables 与证据链（2026-08-29 用户定案：双通道保留）**：卡片交互作为工具调用**进对话转录**（fork 时后台链自然拿到完整证据）；**`/card-event` 保留**做服务端校验+审计落库（不可变事件纪律），不驱动对话流程。

**题序（§10.1 已有设计，未实现，2026-08-29 确认要补）**：两阶段选题——阶段 A 目标选择（覆盖/消歧/前置/复测/训练/高频/迁移），阶段 B 硬过滤+评分（coverage_gain + diagnostic_information_gain + review_urgency + goal_relevance + prerequisite_value - repetition_cost - fatigue_cost - leakage_risk）；辅助模型只在并列/需语言解释时裁决。选题输入 = 上一 Dream 快照 + 本链产出的 handoff。

## 四、未决问题（2026-08-29 全部拍板，决策面闭合）

- [x] 对象存储：**MinIO**（原型期自托管）
- [x] 学生草稿/上传图：**仅对应线程使用**（不跨线程共享）
- [x] 模型并发上限：先不管（实施时按实际观察定）
- [x] 既有轮询客户端（AgentSessionPage/ContentPage）：**无留存必要**——项目围绕 AI 对话，当前前端设计不合理，随重写一并迁移/重构，不为旧客户端保留兼容
- [ ] Tailwind 引入范围（实施时定：建议对话区域先行、全站渐进迁移）
- [ ] 选题器实现细节（实施时细化 §10.1 七类目标的判定依据）

完整重写蓝图见 `docs/对话层重写蓝图v1-线程模型与fork流水线.md`（2026-08-29）。

## 四、文档落地位置

- 官方文档（llms.txt 抓取产物）：`references/assistant-ui/docs-offline/llms.txt`（索引 74KB）、`llms-full.txt`（完整 3.6MB）、`AGENTS.md`、`skill.md`
- 官方仓库（完整 clone）：`references/assistant-ui/`（examples/、packages/、apps/、evals/ 等）
- 本调研与决断：`docs/assistant-ui-集成调研与决断.md`
- 官方仓库 examples 源码：https://github.com/assistant-ui/assistant-ui/tree/main/examples
