# Next 实现隐藏省略与复用专项审计 v2 补充

> **历史补充，已被整合替代，禁止据此直接实施。** 本文使用了不可完整复现的 `dc61617 + 未提交工作树`，并含 O-12、O-15、O-18、O-21、R-27 等错误或过宽结论。权威裁决见 [Next 实现整合审计 v3](./Next实现隐藏省略设计忠实度与复用整合审计v3.md)。本文只作为发现过程与反例留档。

> 审计基线：工作树 `dc61617`（HEAD）+ 未提交改动，2026-08-31
> v1 基线：`ad48c0c`。本文件是 v1 的**增量补充**：v1 原文不动，只记录「v1 论断复核结果」「v1 未提出的新发现」「v1 论断的修正」。两份对照使用。
> 审计范围与 v1 相同：web-next、api-next、pi-chat-runtime、content-next、storage-next、learning-next、packages/contracts 及相关被消费包、db、deploy/dev。旧实现逐步删除，不审计其内部。
> 基线后三个提交是 v1 明确排除的盲区，本次全量审计：`7fa46b7`（read/command API）、`ee348b4`（interaction boundary）、`dc61617`（前台教学接 Temporal）。所有行号均指当前工作树。

## 1. 结论先行

**v1 的 P0 产品闭环类问题已有实质推进。** 历史编辑动作已删除；QuestionCard 已收敛为服务端 CommandCapability 驱动的单幂等命令；正则路由已换 React Router；web-next 新增 `learning/` 树消费 canonical message 与 action 能力；选题→开题→作答→收口→切题的主链路已真实接通（submit_attempt/request_cut 直达 DB 函数，带 RLS、幂等与 outbox，非 stub）。

**但 v1 的基础设施类问题基本原样存在，且新代码在重复制造同一类问题。** 三个新提交带来了：31 条零 schema 路由、手写校验原语的三份复制、第六个独立 pool（连接预算 28→32）、第七份 idFrom、第三套 JSON hash 语义、两套新手写 SSE、选题意图的第二套并行实现、以及一个会在失败后无限重启的 workflow。

**本次新增的 P1 级问题（v1 未覆盖）共 11 个**，最值得注意的：

1. **发送失败静默丢失用户消息**（O-11）：乐观消息被删除且错误无人消费，用户无任何反馈。
2. **取消操作只改库不达 Temporal**（O-12）：取消后模型结果仍可能落盘并推进线程版本。
3. **证据句柄 HMAC 存在公开默认密钥链**（O-13）：默认配置下 evidence handle 可被伪造。
4. **foreground 教学 workflow 失败后无限重启循环**（O-15）：mark failed 后 rethrow，无 workflow retry policy。
5. **action_slots 静态双轨与能力门控三处矛盾**（O-16）：能力公告与领域受理条件不一致。
6. **KTQ/ER 校验规则四份副本且已漂移，host 侧静默默认值污染内容目录**（R-19）。
7. **归档物化跟随 symlink，构成跨租户外泄路径**（R-21）。
8. **头像链路信任声明 MIME、无解码/像素限制、无 nosniff**（R-18）。
9. **两套手写 SSE：1s DB 轮询、无背压、错误吞没**（R-17）。
10. **foreground 输出三套校验并存，canonical schema 零运行时加载，reason 枚举已漂移**（R-20）。
11. **seed.sql 非幂等，`docker compose down/up` 全栈阻塞**（O-21）。

**对用户强调的「不必要手写逻辑」：v1 之后新代码没有收敛，反而新增了更多小规模手写**——SSE 帧协议、offset cursor、校验器、错误类、UUID 回退、shell 转义、魔数嗅探。这些单独看都只有几行到几十行，但每个都在重造成熟库（@fastify/sse、keyset cursor 模式、Fastify type provider、timingSafeEqual、file-type 等）已验证的语义，与登录加载案例同类。

## 2. v1 论断逐条复核

| v1 论断 | 复核结论 | 当前证据（工作树） |
|---|---|---|
| §3.1 历史编辑无后端能力（P0） | **已修复** | 工作树删除 Edit/EditComposer：thread.aui.tsx 动作栏仅 Copy/ExportMarkdown 与 BranchPicker（:369、:435-468），无 Edit |
| §3.2 无可见 Retry 按钮 | 复核成立 | composer 仅 Send/Cancel（thread.aui.tsx:252-279） |
| §3.3 选题算法真实但无产品接线 | 算法侧成立；**产品链路已接通** | 三个基线后提交 + web `learning/` 树走通选题→开题→作答→收口 |
| O-01 P7 只接意图写入（P0） | **大部分修复** | 31 条 read/command 路由（learning-http.ts）、canonical 消费（LearningRuntimeProvider.tsx:100-117）；残留 action_slots 双轨 → O-16 |
| O-02 九任务多类不可达、7 悬空 schema（P0） | **部分修复** | foreground-teaching-input/output 已补（task-registry.ts:129-130）；仍悬空 **6 个 ref/5 个 schema 名**：grade-input(:49)、diagnose-input(:56)、teach-summary-input/output(:62-63)、semantic-decomposition-input/output(:144-145)；foreground_teaching 已接 Temporal（dc61617）；diagnose/teach_summary/semantic_decomposition 仍不可达（后者双重不可达：无触发 + executor 白名单无 `delegate`，pi-task-executor.ts:146） |
| O-03 诊断状态永不收口（P0） | 仍成立（**恶化**） | question-store.ts:637 只写 unclassified/skipped；读 API 已把 "诊断状态：unclassified" 暴露给 UI（learning-read/service.ts:482,538），用户永远看不到终态 |
| O-04 教学卡非 Science 卡、evidence_policy 无消费（P0） | pi 侧仍成立；**前端部分已修复** | learning-ui.ts:36-69 注册工具与字段；SKILL.md 明言卡片不启动工作流 → 字段永无消费者；question-card.tsx（教学卡前端）已删 |
| O-05 题卡两次客户端调用（P0） | **前端已修复** | question-card.tsx 删除；新 QuestionCard 由服务端 CommandCapability（href+expected_version）驱动、单幂等 command（domainPresentationRegistry.tsx:95-129）；残留：本地 `submitted` 过渡态（:75,:122）；interaction_token 仍无消费者 → O-19 |
| O-06 sandboxed_html 字符串黑名单同源（P0） | 仍成立 | artifact-publisher.ts:69-74 正则黑名单；pi-chat-routes.ts:653 `script-src 'unsafe-inline'` 同源直出；前端 window.open 消费方已删（暂无触发路径，风险源保留） |
| O-07 附件 TODO/data URL/Map 生命周期（P1） | **部分修复** | 三处已删（AttachmentAdapter 重构）；残留：`accept="*"`(:35)、手写 init→PUT→complete(:66-91)、pi 物化全量缓冲（→ R-22）、对象无 abort/GC（storage-next 仅 init/complete/presign 三端点）、complete 状态迁移无 `where state='pending'` 原子守卫 |
| O-08 静态 readyz（P1） | 仍成立 | 四服务 lib.ts 固定 200；compose 层另有无健康门禁缺口 → R-28 |
| O-09 认证默认无生产拒绝（P0 面向生产） | 仍成立（部分缓解） | auth.ts:7-10 原样；`updateEmailWithoutVerification:true`(:21)；角色白名单别名已加(:42-45)；旧 Keycloak/OIDC 契约仍存活（providers/auth.ts:1-41）；DB 注释漂移（0001_identity.sql:15,19 的 oidc_sub 现由 Better Auth 复用） |
| O-10 测试绿色占位（P1） | 仍成立（**恶化**） | content-next 0 test exit 0；real-smoke 默认 `localhost:3001` 已完全悬空（旧 api 服务已从 compose 移除）；无任何 Next E2E；P7 新代码零自动化测试 → R-38 |
| R-01 三套后台执行引擎（P0） | 仍成立 | 证据位置更正：pending SQL 在 db/migrations/0031:968-1007（无 FOR UPDATE SKIP LOCKED、无 LIMIT）；content-next 与基线逐字节相同 |
| R-02 三种 Agent Host（P0/P1） | 仍成立 | pi-task-executor.ts 仍手写 models.json/auth.json（:402-403）、workspace、session 生命周期，dc61617 未抽共享内核 |
| R-03 Registry 非事实源（P0） | 仍成立 | executor if/else 工具工厂（pi-task-executor.ts:146,240-297）；schema_uri 仅字符串比对（runtime-store.ts:114 `!==`），全仓无 Ajv |
| R-04 无 route schema（P0） | 仍成立且**新代码延续** | 新增 31 条 learning 路由零 `schema:`；校验原语三份复制（→ C-2）；web 侧第二套手写镜像（learning/contracts.ts + data/client.ts 盲 cast；zod ^4.4.3 已装但 0 引用） |
| R-05 Principal 重复（P1） | 仍成立 | storage-next/lib.ts:56-70 等；角色过滤规则不一致（storage 只留 teacher\|student） |
| R-06 池与 RLS 膨胀（P1） | **恶化** | 6 组 pool：runtime 8、question 6、selection 6、dream 6、outbox-relay 2、foreground 4（foreground-store.ts:48）= **32 连接**；withTenant 六份拷贝 |
| R-07 服务 kit（P1） | 仍成立 | 启动/配置/错误 envelope 仍分散；process.env 散读（api-next index.ts:8-12 等） |
| R-08 relay 手写代理（P1） | 仍成立（+30s 上限） | index.ts:44,:66 `AbortSignal.timeout(30_000)` 作用于整响应，大文件必超时；仅转发 4 个 header → storage `x-mathpilot-storage-audience: runtime` 经网关不可达 |
| R-09 前端手写路由/轮询（P1） | **大部分修复** | createBrowserRouter（app.tsx:19-46）、navigate、useSearchParams 已接入；残留：content-review-page.tsx:81-102 双 2s 轮询 + 7 处 window.location.assign、双 session truth（auth.tsx:44-70）、第四套 fetch 风格 → R-34 |
| R-10 对象生命周期四套（P1） | 仍成立 | avatar bytea 第二条 blob 生命周期仍在（api-next index.ts:127-150） |
| R-11 路径包含重复（P1） | 仍成立（**恶化**） | 13 处实例；新增归档 symlink 外泄 → R-21 |
| R-12 Artifact MIME/magic 重复（P1） | 仍成立（恶化） | 魔数实现第三份：sandbox.ts:162-172（每次图片起沙盒跑 `head\|xxd`） |
| R-13 command/receipt 重复（P1/P2） | 部分修复 | submit/cut/foreground 走 operation/outbox/idempotency；新旁路：api-next 命令层第二套幂等 deterministicId（service.ts:33-36），不复用 learning store |
| R-14 ID/hash/cursor 政策（P2） | **恶化** | idFrom 5 份 + stableId/scientificId 2 份同式（error-core.ts:136、scientific-core.ts:138）；三 hash 语义（→ C-4）；ID 文法正则 6 份（→ C-3） |
| R-15 CSV/迁移 runner（P2） | 仍成立 | 两套手写迁移协议（db/migrate.sh 无锁无 checksum；web-next/db/migrate.sh 表存在性守卫）；CSV parser（migrate-official-content.ts:24-43）无 BOM 处理 |
| R-16 可观测性（P2） | 仍成立 | learning-next 全仓无任何日志（pino/console grep 仅 2 处无关命中）；无 traceparent/OTel |
| §10 已做对部分 | 确认 | 另核实：KaTeX 正确使用 katex/contrib/auto-render（无手写 delimiter 拆分）；对象 URL 正确 revoke；61ef4bc 的模型新鲜度逻辑是领域版本检查，不属于可库化手写 |

## 3. 新发现 A：隐藏省略与伪完成

### O-11（P1）发送失败静默丢失用户消息

- `LearningRuntimeProvider.tsx:151-154`：catch 分支 `setPending(null)` 删除乐观消息后 rethrow；thread.aui.tsx:285-293 的 MessageError 依赖消息存在才能挂载 → 失败后消息列表无该消息、composer 已清空、用户无任何反馈，需重打。
- `!threadId` 分支更糟：createThread 成功并 navigate 到新线程（:128-133）后 sendMessage 失败 → 用户落在空线程。
- 同文件 `operationMessage`（:327-333）已示范正确做法：失败保留消息并置 `status:{type:"incomplete",reason:"error"}`，让 assistant-ui 原生错误语义生效。
- 整改：失败时保留乐观消息并置 incomplete/error；新建线程失败应回滚导航或保留草稿提示。

### O-12（P1）cancelOperation 只改库不达 Temporal，存在「取消后结果仍落盘」竞态

- `learning-command/service.ts:496-527` 仅把 `science_v3_operation` 置 cancelled 并标记 foreground_request cancelled，没有任何 Temporal signal/terminate。
- 运行中的 workflow 在 attempt 间若不回查 cancelled 状态，学生取消后模型结果仍会写入并推进 thread version。需要在命令路径发 `requestCancel`/signal，或让领域提交函数在事务内原子校验 operation 状态。

### O-13（P1）证据句柄 HMAC 存在公开默认密钥链

- `learning-read/cursor.ts:36-42`：`LEARNING_EVIDENCE_SECRET ?? BETTER_AUTH_SECRET ?? "mathpilot-dev-evidence-secret-change-me"`；而 BETTER_AUTH_SECRET 默认值本身是仓库可见的开发 secret（auth.ts:9）。默认部署下 evidenceHandle（:44-48）用公开密钥签名，任意 kind/id/studentId 组合可伪造。
- 实际危害被下游二次校验兜底（resolveLearningSubject 重查师生关系），但签名机制在默认配置下是「安全感字段」。
- 整改：非 development 强制要求 LEARNING_EVIDENCE_SECRET 并启动 fail-fast（O-09 家族新实例）。

### O-14（P1）`present_validated_artifact` 只验形状，「validated」名不副实

- `pi-task-executor.ts:243-248`：content 为 `Type.Record(String, Unknown)`，仅 ≤64 键；artifact_schema 正则只匹配名字形态（foreground-core.ts:6），registry 中根本不存在 teaching-artifact/* schema，无任何内容对照声明 schema 的校验。
- 整改：要么注册并真正校验 teaching-artifact schema，要么改名去掉「validated」承诺。

### O-15（P1）Agent workflow 失败后无限重启循环

- `foregroundTeachingWorkflow`（workflows.ts:352-364）与通用 `agentTaskWorkflow`（:180-203，light/rem/deep 等经其路由）的 catch 均 markOperationFailed 后直接 rethrow；`outbox-relay.ts:159-166` 启动 workflow 未设 workflow retryPolicy（全仓 retryPolicy 只用于 activity 级，workflows.ts:82-106）→ Temporal 默认无限重试。
- 新一次 workflow run 的 startAttempt 因 operation 已 failed 立刻抛「operation is not runnable」（runtime-store.ts:294-306）→ activity 再重试 → 再 mark failed → 再重启，永久僵尸循环；runtime-store.ts:304 的 `retryable: !input.cancelled` 与该行为自相矛盾。
- 对照：`selectQuestionWorkflow`（:405-560）失败时返回 failed 状态而不 rethrow，没有此循环——但同样没有把「失败」作为产品可见结果处理。
- 整改：mark failed 后抛 `ApplicationFailure.nonRetryable`，或 relay 启动处设 workflow retryPolicy（maxAttempts）。

### O-16（P1）action_slots 静态双轨，能力公告与领域受理三处矛盾

- `selection-store.ts:760` 开题时写死 4 个 slot（submit_attempt/skip_question/request_cut/revise_intent），写入后永不刷新；提交作答后 canonical message 仍宣称 submit_attempt。
- `skip_question`、`revise_intent` 两个 slot 在任何能力/命令中都不存在（skip 已并入 request_cut reason）。
- 能力门控与领域矛盾：`revise_selection_intent` 无条件公告（learning-read/service.ts:253-254），但领域只在无 active question 时受理（foreground-store.ts:164-166 拒 conflict）→ 有题时用户点它必浪费一次完整 selector 运行；`submit_attempt` 以 `!row.attempt_id` 门控（:337-338），首个 attempt 后能力消失，与多 attempt 领域模型（supersede）矛盾——学生发过一次 probe 后再无法提交正式作答。
- 整改：capability 按领域状态生成（current_question==null、attempt 可 supersede 等），DomainUIPart 删除静态 action_slots 或随状态重生成。

### O-17（P2）`content_package.status='withdrawn'` 枚举终态无生产者

- CHECK 约束含 withdrawn（0031_content_pipeline_cutover.sql:610），但 withdrawPackage 只更新 `content_package_class_release.withdrawn_at`，从不更新包状态；全部班级撤销后包仍永远 published。与 v1 O-03 同型：枚举终态无写入路径。
- 整改：最后一个有效 release 撤销时置 withdrawn，或从枚举中删除该值。

### O-18（P2）写入后无消费者的字段与对象

- `candidate-repository.ts:219` model_id/prompt_version 写入后 get()/list() 从不读出；`migrate-official-content.ts:274-281` content_source 落库全仓无读取方；0031:956-964,1025 `mathpilot_content_candidate_visible` 视图定义并授权但无任何调用点。
- 整改：删除死字段/对象，或接入读模型。

### O-19（P2）interaction_token 生成即弃

- `artifact-publisher.ts:174` 生成并持久化 interaction_token；pi-chat-routes.ts 全文件零引用（grep 确认），读取路径只按转录 tool_call_id 验证。「防重放」语义从未生效。
- 整改：接入真校验（幂等 command）或从 Schema 删除。

### O-20（P2）dedup_action/duplicate_of 是伪能力

- Python 侧要求 dedup_action ∈ {new,duplicate,merge} 且 duplicate/merge 必带 duplicate_of（validate.py:64-66）；content-next 与 pi-chat-runtime 的 TS 侧全仓零引用（grep 确认）。模型声明「这是 Q_x 的重复题」时 host 仍作为全新实体插入。
- 整改：host 实现与 Python 一致的 dedup 分支（或按 R-04 收敛为唯一 schema），否则该字段是「声明过但没有消费者」。

### O-21（P2）seed.sql 非幂等，`docker compose down/up` 全栈阻塞

- `deploy/dev/seed.sql` 全文件 0 处 ON CONFLICT；compose.yaml:84-107 db-seed 是一次性容器，learning/api/content/storage 全部 `depends_on: db-seed service_completed_successfully`。
- 容器重建（down 后 up、配置变更）时 seed 重放 → 主键冲突 → 非零退出 → 全栈阻塞，且错误信息与真正迁移失败无法区分。
- 整改：seed.sql 全面 ON CONFLICT（或先 DELETE 再灌），并验证 down/up 幂等。

## 4. 新发现 B：不必要的手写逻辑与库替代

### R-17（P1）两套手写 SSE 帧协议

- pi：`pi-chat-routes.ts:896-916` — `reply.hijack()` 裸写 `data: ...\n\n`，20s setInterval 心跳对 `reply.raw.write` 返回值与错误无任何处理（socket 关闭窗口内 EPIPE 无人捕获）；无 `retry:` 字段。
- api-next：`learning-http.ts:240-282` — 每个在线客户端每 1s 一次完整 DB 查询（恒定 1qps/客户端）；write 返回值忽略、无背压；catch 把一切错误折叠为 `retryable:true`。
- 整改：`@fastify/eventsource` 或 `@fastify/sse`；api-next 的「1s 轮询推事件」改用 pg LISTEN/NOTIFY（或 pg-ipc）。

### R-18（P1）头像链路信任声明 MIME、无解码/像素限制、响应无 nosniff

- `api-next/src/index.ts:137-150`：POST 仅校验声明 mime 白名单与 base64 长度，`Buffer.from` 直接入库——1.5 MiB 内任意字节可声明为 image/png 写入 bytea；GET（:127-135）按声明 content-type 原样回吐且无 `X-Content-Type-Options: nosniff`、无 content-disposition → 同源认证页面上存在 MIME-sniffing 型存储 XSS 面。
- 前端 `account-panels.tsx:114-169`：文案称「最大 1.5 MiB」但代码不检查 file.size，超大文件整体 FileReader→base64（+33%）上传。
- 整改：sharp 解码-重编码-限像素（≤1024×1024），file-type 验 magic，响应加 nosniff；前端 encode 前检查 size。

### R-19（P1）KTQ/ER 校验规则四份副本且已漂移，host 静默默认值污染内容目录

- 副本：agent-runtime/skills/*/validate.py、pi-chat-runtime/skills/*/validate.py（ER 副本已新增 output_file 目录包含/绝对路径/NUL 检查，另一份没有）、candidate-repository.ts host 校验、content-result-validation.ts。
- 漂移实例：TS 去重 `toLocaleLowerCase()`（content-result-validation.ts:90，依赖运行环境 locale）vs Python `casefold()`（validate.py:24）。
- 更严重：TS 侧不校验而默认值兜底——difficulty 任意有限数（Python 要求 [0,1]）、stem_format 任意串一律存 `"open_solution"`、measurement_targets role 任意串存 `"primary"`（candidate-repository.ts:229,243,404）。绕过 Python 校验的负载（或两副本漂移后）会把 `"mcq"`、difficulty 5 等写进正式目录，无任何错误。
- 整改：canonical KTQ/ER JSON Schema + Ajv（host）/jsonschema（Python）+ 同一 golden fixtures；register 前未知枚举/越界直接 422，禁止默认值吞非法值。

### R-20（P1）foreground 输出三套校验并存，canonical schema 零运行时加载，reason 枚举已漂移

- 三套：foreground-core.ts:38-127,195-240 手写 exactKeys/正则；pi-task-executor.ts:230-249 TypeBox 工具 schema 重复声明同一文法；ee348b4 新增的 foreground-teaching-output.schema.json / learning-action.schema.json 运行时从不加载（runtime-store.ts:114 只比对 URI 字符串，全仓无 Ajv）。
- 漂移实锤：request_cut reason 在 foreground-core.ts:29 是 5 个枚举（无 teacher_switch），api-next learning-command/service.ts:345 是 6 个——同一命令两个入口行为不同。
- 整改：在 loadInputBundle 与 executePiTask 输出处用 Ajv 加载 canonical schema 校验；跨记录绑定检查（intent revision/attempt ref）才留给领域 parser。

### R-21（P1）归档物化跟随 symlink，构成跨租户外泄路径

- `pi-object-store.ts:34-46` uploadDirectory 用 `readdir(withFileTypes)` 后对非目录直接 `fPutObject`——symlink 落入 else 分支被跟随上传。触发点 `pi-chat-routes.ts:879-888`：archive 上传整个 workspace（含模型可写的 output/）。
- 模型在 output/ 放 symlink 指向服务用户可读的任意文件（其他租户 workspace、auth.json 等），归档即把目标内容写进本线程 MinIO key；随后恢复/物化路径可被读回。collectFiles（artifact-publisher.ts:56）已拒绝 symlink，此处缺同一道闸。
- 另：downloadDirectory（pi-object-store.ts:48-62）用 MinIO 返回的 object.name 直接拼路径，无包含校验、无并发上限地 fan-out fGetObject，且每次 GET /pi/threads 与 artifact GET 都全量恢复归档。
- 整改：lstat 拒绝 symlink、object 名包含校验、并发限流、热路径不恢复归档。建议排在 O-06 之前（同为安全边界，此条有真实触发路径）。

### R-22（P1）物化全量入内存、无本地大小护栏、120s 整包超时

- `pi-chat-routes.ts:769-773`：`Buffer.from(await response.arrayBuffer())` 整体载入；storage 侧上限 256MiB，pi 侧缓冲前不检查 grant.byte_size；`AbortSignal.timeout(120_000)` 覆盖整个 body，慢网络下大附件下载中途超时 → 422 丢弃已下载数据。
- 整改：`response.body` 流式写临时文件 + 增量 sha256 + 流中限幅（v1 O-07 整改方向）。

### R-23（P2）手写 UUID v4 回退与 Math.random 幂等键回退

- `AttachmentAdapter.tsx:18-30`：手写 16 字节版本位设置与 hex 拼接；`learning/data/client.ts:30-35`：无 crypto.randomUUID 时退到 `Date.now+Math.random`——快速双击下可能撞键击穿幂等。
- `crypto.randomUUID` 已普遍可用；回退应删除或换有审计的 uuid 库。

### R-24（P2）两套手写 offset cursor，多 kind 分页静默失效

- `learning-read/cursor.ts:9-29`（base64url 前缀 + offset）与 `selection-core.ts:262-279`（base64url JSON {version,scope,offset}）两套 codec 互不共享；`learning-read/service.ts:513,668,732` 的 history/memories/reviews 用 offset 分页（每页 O(n) 扫描、插入导致窗口平移跳行/重复），而 threadMessages 用 `sequence>$3` 真 keyset（:142）——同一文件两种哲学。
- content-next `index.ts:169-176` + `candidate-repository.ts:810-856`：offset 型 cursor；`requested.length !== 1` 时 :855 强制 offset=0 且 next_cursor 恒 null——多 kind 搜索「下一页」无任何反馈。
- 整改：keyset cursor（按稳定排序键编码），codec 共享（排序语义仍属领域）。

### R-25（P2）三套平行错误类 + 无全局 error handler，500 泄漏内部细节

- SelectionCommandError / LearningCommandError / LearningReadError 三套；映射器 service.ts:558-570 手写 pg code→HTTP 表；envelope 手写于 learning-http.ts:24-45。
- api-next 没有全局 error handler：problem() 里 rethrow（:44）的未知错误走 Fastify 默认 500 并携带 err.message（SQL 细节可能外泄）；storage-next 反而有遮蔽处理（storage-next/index.ts:54-63）——两服务行为不一致。
- 整改：单一 AppError + 全局 errorHandler（保留 problem+json 格式）。

### R-26（P2）内部 shared secret 用普通 `===` 比较

- `storage-next/lib.ts:56-59` trustedRuntime 字符串恒等比较；同仓 `learning-read/cursor.ts:57` 已示范 `timingSafeEqual`。
- 整改：`crypto.timingSafeEqual`。

### R-27（P2）无速率限制 / 安全头 / CORS 插件

- api-next、storage-next 无 @fastify/rate-limit、@fastify/helmet：学习命令、SSE、上传 init/complete 均无节流；登录暴力破解依赖 Better Auth 默认（未显式开启 rateLimit）。
- 整改：按路由组限流 + 统一安全头插件。

### R-28（P2）compose 健康门禁缺口（O-08 的 compose 层）

- `deploy/dev/compose.yaml` 全文件仅 2 处 healthcheck（db、temporal 附近）；minio（:42-53）无 healthcheck；storage-next→minio、pi→content/storage、api→content/storage 均为 `service_started`。
- MinIO 冷启动数秒，storage-next 启动即 presign 必失败。
- 整改：minio 加 `mc ready` healthcheck；各服务 healthcheck 指向真实依赖探测的 /readyz；depends_on 统一 `condition: service_healthy`。

### R-29（P2）Dockerfile 双模板，层缓存策略不一致

- learning-next/Dockerfile 选择性 COPY（缓存友好）；api-next/Dockerfile:5 与 web-next/Dockerfile:4 均 `COPY . .` 全仓拷贝后再 install——任何源码变更使依赖层缓存全失效。
- 整改：统一「选择性 COPY 依赖清单 → install → COPY 源码」多阶段模式。

### R-30（P2）仓库没有任何 CI，v1 §9 全部守门无承载者

- 无 .github/（及任何 CI 目录）；根 package.json 的 `pnpm -r --if-present run test` 即全部质量关卡，且被 content-next 0-test 绿化。
- v1 §9 的 schema 存在性、0-test 失败、dependency-cruiser、jscpd、禁止裸 process.env 等守门一个都没有落地为可执行检查。
- 整改：最小 GitHub Actions（typecheck + test + registry-schema 存在性脚本 + 0-test 检测），先于其他治理投入。

### R-31（P2）contracts 包 TS 类型与 JSON Schema 手写双源

- contracts/package.json 无任何 dependencies；science-v3-learning.ts（约 600 行手写类型）与 schemas/science-v3/*.json 无生成关系，两侧改动互不报错。
- 整改：json-schema-to-typescript（或等价）从 schema 生成类型 + CI 一致性检查，终止手工双源。

### R-32（P2）手写 shell 转义与每次图片魔数起沙盒进程

- `extensions/sandbox.ts:95` shellArg 手写单引号转义拼 bash -c；:162-172 为嗅探 3 个魔数每个图像起一个完整沙盒 bash（`head|xxd`），且是 R-12 之外的第三份魔数实现。
- 整改：file-type（进程内魔数）；execFile argv 传递避免 shell。

### R-33（P2）发布索引 read-modify-write 竞态 + 非原子写 + 每次 GET 重发布

- `artifact-publisher.ts:118-123,179`：agent_end 发布与浏览器 GET 并发各自加载 published-artifacts.json，最后写者胜，可能丢失对方 descriptor → 已发布产物 404；`writeFile` 非原子，崩溃产生撕裂 JSON → 该线程全部 artifact 永久 404；每次 artifact GET 都重读+重哈希整个产物目录（pi-chat-routes.ts:640-641）。
- host-principal.ts:19-27 已有 tmp+rename 原子写先例，此处未用。
- 整改：每线程互斥 + 原子 rename；GET 只读索引不重发布。

### R-34（P2）前端残留手写（R-09 的剩余清单）

- 第四套 fetch 风格：content-package-page.tsx:24 与 account-panels.tsx:295-317 的 jsonFetch 绕过已装的 TanStack Query；content-api.ts + learning/contracts.ts 手写 DTO 无生成关系、requestJson 盲 cast（client.ts:37-56），LearningRecords.tsx:369-390 防御式 stringValue 把契约漂移掩盖成空白 UI。
- content-review-page.tsx:81-102 两套 2s 全量轮询 + 7 处 window.location.assign 整页跳转丢状态。
- 双 session truth（auth.tsx:44-70）：手写 /api/me 瞬时失败即置 principal null，会话有效却闪现未登录并切到 guest runtime。
- markdown-text.tsx:67-73 复制计时器 setTimeout 无清理，3s 内连续复制提前翻回状态。
- 死代码：tool-fallback.aui.tsx（约 400 行零引用）、surfaces.tsx 的 iconSwap/labelSwap/ghostButton/inkButton/codeScroll/codeSurface/fieldInteractive 零消费。
- 题卡 URL 手写字符串手术（domainPresentationRegistry.tsx:78-79 `resource_ref.replace(...)` 再拼 URL）——格式一变即静默断链，建议 DomainUIPart 直接下发 view href。
- 整改：与 R-09 同一方向——TanStack Query 统一 server state、useNavigate 取代 location.assign、principal 单一来源、删除死代码。

### R-35（P2）bindAttachmentTurn 崩溃窗口 + prompt 全等匹配

- `extensions/attachments/manifest.ts:67-85` 先 rename pending→bound 再写 turn 文件；进程在两步之间崩溃留下 bound 孤儿，恢复时 findAttachmentTurn 抛「invalid bound attachment」且无法自愈。:127 `turn.prompt === prompt` 字符串全等——重试时 prompt 微变（空白/换行）则附件绑定静默跳过，文件到不了模型。
- 整改：先写 turn 文件再迁移（或单 JSON 状态文件）；按 turn id 而非 prompt 匹配。

### R-36（P2）frozenKtq N+1 查询

- `candidate-repository.ts:736-776`：每题在循环内跑 2 条查询（measurement targets + knowledge），20 题 = 41 次往返，同一事务串行。
- 整改：单条 SQL LATERAL JOIN 一次取全量。

### R-37（P2）content 命令无终态/DLQ，last_error 单槽覆盖，队头阻塞

- `candidate-repository.ts:1097-1106,1139-1150` + 0031:582（status 仅 pending/dispatched）：Pi 永久不可达时命令以 10 分钟上限无限重试，last_error 每次被覆盖无历史，无 dead-letter。
- `index.ts:19,56,90` + :40-63/:72-98：每命令顺序执行 + `AbortSignal.timeout(10*60*1000)`——单个 Pi 请求挂起阻塞同 dispatcher 全部后续命令。
- 整改：与 R-01 一并治理（迁 Temporal 或至少增加失败终态/告警/限并发）。

### R-38（P2）P7 全链路零自动化测试

- 基线后新增 31 条 learning 路由、learning-command/service、learning-read/、web-next learning/ 树（手写 fetch client 与 DTO）没有任何服务端或浏览器测试；api-next 无 test/ 目录；全仓无 Playwright。
- 与 O-10 的「0 测试绿」叠加：当前主要开发阶段完全无测试保护。
- 整改：learning-http 补 node:test 路由测试；至少一条 Playwright E2E 走 web-next→api-next→learning-next 全链。

## 5. 新发现 C：跨职责重复清单（v1 未覆盖的新实例）

| 重复机制 | 份数 | 位置 | 对应条目 |
|---|---|---|---|
| 选题意图创建（构造 selector bundle + 写 intent/outbox/selection_request + bump version） | 2 | foreground-store.ts:289-446 vs api-next/learning-selection.ts（467 行近同构） | 建议收敛为共享 DB 函数（submit_attempt/request_cut 已示范该模式） |
| 命令校验原语（objectValue / 幂等键正则 / sha256） | 3 | learning-command/service.ts:22-51 vs learning-selection.ts:66,73-116；两处错误文案已不一致 | R-04 |
| KTQ/ER 校验规则 | 4 | agent-runtime skills、pi-chat-runtime skills、candidate-repository.ts、content-result-validation.ts | R-19 |
| SSE 帧协议 | 2 | pi-chat-routes.ts:896-916、learning-http.ts:240-282 | R-17 |
| MIME/魔数表 | 3 | artifact-publisher.ts:76-87、pi-chat-routes.ts:643-648、sandbox.ts:162-172 | R-12/R-32 |
| ID 文法正则（thr_/fge_/msg_/art_/qsn_/stu_…） | 6 | foreground-core.ts:3-6、runtime-store.ts:140-144、workflows.ts:317-319、outbox-routing.ts:63,77-78、selection-core.ts:114-117、api-next service.ts:22-27 | R-14 |
| SHA 截断 ID helper | 7 | 5 份 idFrom（question/selection/dream/runtime/foreground-store）+ stableId（error-core.ts:136）+ scientificId（scientific-core.ts:138） | R-14 |
| JSON hash 语义 | 3 | 裸 JSON.stringify（foreground-store.ts:9）、jsonArtifact（question-store.ts:20-25、dream-store.ts:31-36）、sortJson（selection-core.ts:244-254）——同一 payload 不同模块 hash 不同 | R-14 |
| 错误类与 problem+json | 3 | SelectionCommandError / LearningCommandError / LearningReadError + 各手写映射 | R-25 |

## 6. v1 整改顺序修正

**第一批（阻止错误能力暴露与安全边界失真）新增：**

1. seed.sql 幂等化（O-21）——一条命令即可让所有开发环境 down/up 卡死。
2. 归档 symlink 拒绝（R-21）——有真实触发路径的跨租户外泄。
3. workflow retry policy / nonRetryable（O-15）。
4. 证据密钥 fail-fast（O-13）与头像链路 sharp+file-type+nosniff（R-18）。
5. 发送失败保留乐观消息并挂 error 状态（O-11）。

**第二批（P7 闭环）：** 主链路已接通，验收前必须关闭 O-11/O-12/O-16 与 R-20（reason 漂移）；原第 1、2 条（canonical read model、action slots）已基本完成，第 3 条（诊断终态）仍未动。

**第三批（可靠执行收敛）：** dc61617 把前台教学迁入 Temporal 方向正确，但 O-15 说明「迁入」不等于「迁移质量合格」；Content 迁移试点仍未开始（R-01 原样）。

**第四批（库替换）新增：** SSE（R-17）、cursor（R-24）、错误类/全局 handler（R-25）、timingSafeEqual（R-26）、rate-limit/helmet（R-27）、compose healthcheck（R-28）、Dockerfile 统一（R-29）、CI（R-30）、contracts 类型生成（R-31）、发布索引原子性（R-33）、P7 测试（R-38）。

**复核表结论**：v1 §6 决策矩阵与 §7 抽象边界无需修正，全部仍然成立；v1 的库推荐无一被推翻。

## 7. 验证记录与限制

- 本文件全部 P0/P1 发现与大部分 P2 发现的行号由复核者直接读文件/grep 核实（当前工作树）；少数 P2 的机制性描述来自区域审计 agent 证据，行号已抽查一致。
- content-next 与 pi-chat-runtime 自 v1 基线以来无任何变更（git diff 为空），其 v1 行号映射 1:1。
- 悬空 schema 计数：v1 记 7 个；现为 6 个 ref/5 个 schema 名（foreground-teaching-input/output 已补），registry 其余引用仍悬空。
- 静态审计边界同 v1：多副本 worker 竞争、kill 注入、MinIO/Temporal 故障注入、交互 Artifact 浏览器攻击、O-15 循环的动态复现等仍需在整改批次中加入动态验证。
- 本文对基线后工作不做否定：三个新提交把 P7 主链路从「后端孤岛」推进到「可操作产品」，以上发现是继续推进时需要关闭的缺口。
