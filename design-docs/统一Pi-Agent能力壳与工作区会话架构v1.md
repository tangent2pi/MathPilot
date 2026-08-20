# 统一 Pi Agent 能力壳与工作区会话架构 v1

> 日期：2026-08-20
> 状态：本文件取代“为 KTQ、ER、Teaching 分别组装不同简化 Agent”的实现解释；科学内核、Dream 权限和内容发布门仍以系统设计 v3.3、架构修订 v4 为准。

## 0. 设计结论

MathPilot 只维护一套 Agent 壳：**原生、完整的 Pi Agent Session + SCNET 主模型 + 统一能力系统 + 受控工作区文件系统 + 统一 Session 事件协议**。

KTQ、ER、Teaching、Diagnose、Dream 与 Plan 不是六套 Agent 运行时。它们的差别只能来自：

1. 当前 Session 的任务目标与 Prompt；
2. 工作区中可见的原件、OCR、题目、学生投影和历史摘要；
3. 当前任务 Skill 及其输出契约；
4. 数据库能力所绑定的主体、租户和只读/写入权限；
5. 主/辅模型配置实例。

不得通过修改 Pi agent loop、裁掉原生多轮能力、在领域服务中手写“模型下一步必须调用什么”，来模拟不同 Agent。

## 1. 固定壳层

```text
Web / Domain Service
  └─ Agent Shell API
      ├─ Pi SessionManager：JSONL transcript、多轮续接、取消、排队消息
      ├─ SCNET Provider：主模型原生 text + image 输入
      ├─ Capability Registry：所有 Session 使用同一能力目录
      ├─ Workspace Builder：按主体/任务生成只读输入和可写输出
      ├─ Database Access：沙箱内标准客户端 + 绑定租户和主体的数据库身份
      ├─ Artifact Publisher：manifest 校验、离线检查、不可变发布
      └─ Session Projector：公开回复、工具动作、产物与用量投影给前端
```

领域服务负责业务状态机、确定性程序、事务和权限；Pi 负责模型循环、工具选择和多轮对话。`respond` 只是领域任务的结构化交接工具，不等于单次模型调用，也不终止该 Session 的后续续聊能力。

## 2. 统一能力系统

| 能力 | 形态 | 职责 | 不负责 |
|---|---|---|---|
| Bash | Pi 标准工具，工作区沙箱 | `rg/find/sed/jq` 检索；Python/Node 数学与产物脚本；只写 `output/tmp` | 网络搜索、越权读宿主文件 |
| Qwen-MM Core | 本地 MCP | 原图/视频观察，PDF/Office/数据渲染，裁剪、框选、保存视图 | OCR 云服务、第二次模型推理 |
| PaddleOCR-VL 1.6 | 官方 MCP/异步 API | 高精度文字、公式、阅读顺序、版面块、坐标、分页 Markdown 与切图 | 理解草稿辅助线、几何图形语义或替代原图 |
| Search | Qwen-MM Search Skill + MCP | 外部事实、教学研究依据、来源核验；反向图片检索仅用于公开或获准外发素材 | 工作区文件检索、外发学生草稿或未发布资料 |
| edu-agent | Qwen-MM 完整 Pi Skill + 本地 Hyperframes | 同一 SCNET 模型复用官方设计系统、资产和检查脚本生成离线 HTML/视频 | DashScope/Qwen-TTS/第二模型调用 |
| teaching-artifact-adapter | MathPilot Skill | 将 Edu Agent 产物适配为离线、可校验、不可变的 Learning Artifact | 替代官方 Edu Agent 资产或另起模型 |
| teaching-card | MathPilot Skill | 原生题卡/HTML 卡片协议、事件与可跳过规则 | 自行判答、写长期画像 |
| database | Bash 环境中的标准 PostgreSQL 客户端 + 独立 DB 身份 + database Skill | 模型自行编写 SQL/Python，读取当前租户 KTQRE、题目、学生/会话投影 | 新增 Pi 专用工具、跨租户读取、写正式表、绕过领域事务 |
| respond | MathPilot 结构化交接工具 | 提交当前任务契约结果 | 代表 Session 生命周期结束 |

能力目录对所有管线相同。任务 Prompt 可以说明推荐路径和权限边界，但不得靠“某类任务不注册工具”来形成业务隔离；真正隔离由工作区挂载、数据库主体和 Artifact/领域服务权限完成。

### 2.1 运行时 Skill 标准

运行时只有一棵 `/opt/mathpilot-skills`。其中 `core`、`search`、`edu-agent` 来自本地
`references/qwen-mm-plugins` 固定提交 `dd029da3bcadfe497de4b4ca8976b11177997cf0`；
`database`、`ocr-routing`、`teaching-card`、`teaching-artifact-adapter`、`ktq-extraction`、
`er-research` 是 MathPilot 适配与业务 Skill。Core/Search 的 Skill 与 MCP 必须配套，Edu Agent
保留完整资产树且仅作为 Skill。运行时不再存在 `/opt/qwen-mm-skills` 或第二份同名 Edu Skill。

所有正式 Skills 必须采用同一可验证结构，不能只有一段塞进系统提示词的说明：

```text
<skill>/
  SKILL.md               # YAML frontmatter 只含 name/description；正文说明何时使用与完整流程
  agents/openai.yaml     # UI/资源加载元数据
  assets/                # 可复制的结果、查询、卡片或 Artifact 模板
  scripts/               # 确定性验证器；失败必须非零退出并给出字段级原因
```

模板定义模型应写出的文件形态，验证器定义领域服务接受的最低契约；二者必须随 Skill 版本共同维护。任务 policy 只负责选择任务目标、Prompt 版本和主/辅模型角色，不复制 Skill 的完整操作手册。任何新增 Skill 都必须先通过 `skill-creator` 的结构检查，再用一份有效夹具和至少一份无效夹具验证其脚本确实能接受/拒绝。

KTQ/ER 的最终交接固定为：Agent 先把完整结果写入 `output/`，执行 Skill 内验证器生成包含文件 SHA-256 的 receipt，再由 `respond` 只引用结果文件与 receipt。Runtime 必须独立重算哈希并再次运行同一个验证器；不得把一份已验证 JSON 复制进 `respond` 参数后继续手工微调。其他文件型 Skill 同样遵循“模板 → 写文件 → 验证 → 引用”的顺序。

## 3. Core 与 PaddleOCR 的路由

图像类输入必须保留原件，并按信息需要组合能力：

1. **先观察原件**：主模型原生图像输入或 Core `read_image` 判断内容类型、清晰度、几何图/辅助线/手写结构是否关键。
2. **清晰且无需精细版面**：直接基于原图工作，不为“流程完整”盲目 OCR。
3. **文字密集、卷曲/倾斜、公式/表格、多栏、局部太小**：调用 PaddleOCR，保留 Markdown、结构化 layout、bbox、分页与切图。
4. **局部核验**：根据 OCR bbox 用 Core `crop/draw_bbox/save_view` 放大并重新观察原图；OCR 文本只是索引和证据，不是图像真相。
5. **学生草稿**：默认原图语义优先。OCR 可辅助定位文字和版面，但辅助线、图形、圈画、箭头和空间关系必须回到原图核对。
6. **内容抽取**：原始文件、OCR 全量结果、切图和既有库同时进入同一个批次工作区；任何 OCR 结果都要可追溯回原件页码与 bbox。

PaddleOCR 官方 MCP 支持 `PaddleOCR-VL-1.6` 与 AI Studio source；异步 API 使用 `/api/v2/ocr/jobs`，并提供方向分类、文档矫正、图表识别等选项。产品默认值应保守，具体资料可由 Agent 根据原图检查后选择，而不是全局固定关闭或开启。

## 4. 工作区控制面

所有 Session 使用同一目录协议，实际内容按任务生成：

```text
/workspace
  AGENTS.md                    # 通用纪律、能力索引、任务目标，不含秘密
  # 完整 Skills 固定从 /opt/mathpilot-skills 读取，不在工作区复制第二份
  task/runs/*.json             # 每轮输入与业务目标
  input/original/              # 原始上传文件，只读
  input/ocr/                   # OCR Markdown/layout/bbox/images，只读
  input/library/               # 数据库能力说明和必要的稳定引用，不再复制全库 JSON
  input/question/              # 正式题卡、rubric、题图及来源，只读
  input/student/               # 最小画像、状态、时间/连续作答、历史摘要，只读
  input/session/               # 当前会话公开 transcript、前序题递归摘要，只读
  input/sources/               # 内容管线同批原件、OCR/版面与切图证据
  input/ktq-evidence/          # ER 继承的 KTQ 已验证 output；不含 KTQ transcript
  output/artifacts/            # 待发布卡片、HTML、视频、图片
  output/drafts/               # 当前任务结构化草稿
  tmp/                         # 可丢弃临时文件
  .agent/events.jsonl          # 去除私有思维后的公开会话投影
  .agent/published/            # 已校验且不可变的 Learning Artifact
  .agent/capsule/              # 输入来源、文件哈希、运行清单、压缩 transcript 与保留状态
```

教学 Session 至少提供 `rg`、Python、Node、`jq`、ffmpeg、Chromium/Hyperframes、常用数学计算库；原件和输入只读，只有 `output/tmp` 可写。供应商密钥永不进入 Bash 环境或工作区。

### 4.1 任务工作区差异

- **KTQ**：整批原件 + 全量 OCR + bbox/切图 + 当前章节/全租户既有 KTQRE 只读数据库能力；目标是穷尽、跨文件合并和去重，只提交 K/T/Q。
- **ER**：冻结 KTQ + 同批原件/既有 OCR Artifact + KTQ 已验证 output 证据 + 既有 KTQRE 只读数据库能力；目标是 E/R，可按需 Search 并保存来源。ER 与 KTQ 保持独立 Session、工作区和 transcript。
- **Teaching/Diagnose**：`input/question/current.json` 保存当前题与 rubric；`input/student/short-profile.json` 和 `current-state.json` 由固定程序装配；`input/session/continuity.json` 保存辅助模型上一版递归摘要，`public-history.json` 保存当前公开会话，`current-request.json` 保存本轮请求。不得看到其他学生。
- **Dream**：只见通过完整性门的 SER/TSS 窗口和上个快照；不获得教学对话写权限。
- **Plan**：只见确定性任务草案与允许的画像事实；不能增删或重排任务。

## 5. 数据库能力与身份

不得把全量 KTQRE/学生状态复制成一次性的巨大 Prompt JSON，也不得把通用应用账号交给模型。数据库访问不是一个新增的 Pi 工具：Agent 继续只用 Bash，在沙箱内通过 `psql` 或 Python PostgreSQL 驱动自行查询。`database` Skill 必须给出连接方式、可查询对象、示例、返回约定和权限边界，避免模型猜测库结构。

- Agent Runtime 只向 Bash 子进程注入 `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`；凭据不写入工作区、Prompt、事件或 MCP 环境；
- `PGHOST` 指向仅挂进当前沙箱的 Unix socket，沙箱不因此获得通用网络；
- 每个租户/学生使用独立 PostgreSQL 登录身份和独立派生凭据，身份由 Session 的已验证主体确定；当前沙箱即使看到自身连接环境，也不能用同一密码切换为其他角色；
- 身份不拥有业务表权限，只能执行按 `session_user` 查找作用域的 `SECURITY DEFINER` 只读函数/视图；接口不接受 tenant/student 越权参数，返回稳定引用和版本字段；
- 正式写入仍由模型在 `output/` 产生结构化文件或 `artifact://` 引用，再交领域服务校验、事务提交和审计；数据库身份不能修改正式表。

因此，数据库是工作环境的一部分而非功能型工具。工具集保持精简，权限由数据库身份、Unix socket 挂载和 SQL 授权共同完成。

### 5.1 公共库与教师库两级内容权限

结构化 K/T/Q/E/R 内容划分为两个可见等级：

- **公共等级**：由具有管理员属性的教师通过正式 KTQ/ER 管线建立、复核和发布；作为未绑定教师学生的唯一教学库，也是所有已绑定学生都可使用的基础库。
- **教师等级**：由普通教师通过同一 KTQ/ER 管线建立、复核和发布；内容归属于该教师，仅向与该教师建立有效绑定关系的学生开放。
- **未绑定教师的学生**：教学、诊断、选题和数据库查询只能读取公共库。
- **已绑定教师的学生**：可读取公共库与所绑定教师的教师库；不得读取其他教师私有库。若以后允许多教师绑定，必须先明确并集、主教师和解除绑定后的历史证据规则，不能隐式扩大权限。
- **Agent 工作区与数据库身份**：Teaching/Diagnose/Plan 等 Session 必须继承学生当前绑定关系，通过数据库行级范围或安全只读投影得到相同的两级可见集合；不能把 `teacher_id` 作为模型可任意填写的查询参数，也不能复制越权内容到工作区文件。
- **内容生产去重**：公共库 KTQ/ER 应在公共范围去重；普通教师生产教师库时至少能查询公共库与本人教师库用于去重，但不能查看其他教师库。
- **来源与发布**：内容等级、所有者、来源批次、复核者、发布版本和 supersede 关系必须随题目及 K/T/E/R 关联保存；教师内容不得因学生解绑而改写历史 Session 证据。

当前实现以 `identity_teacher_student_binding` 保存可撤销的有效绑定，以
`content_entity_scope` 和 `content_source_document_grant` 保存实体/原件的公共或教师授权。
普通教师的内容 Agent 使用按教师动态创建的只读 PostgreSQL 身份，可见公共库与本人教师库；
教学身份按学生当前有效绑定计算公共库与所绑定教师库。浏览器 API、复核队列、内容导出、
Agent 安全函数和学生选题共用同一范围事实。`content-scope-smoke.sh` 在事务内验证本人、其他教师、
未绑定、绑定、撤销和重叠授权六种情况并回滚测试数据。

后续业务扩展仍需设计内容转移、已发布版本撤回、解绑后的历史证据展示和多教师绑定；当前状态机
保持一个学生同一时间最多一位有效教师，解绑只影响后续可见性，不改写历史学习证据。

## 6. Session 与前端统一投影

统一 Session API 至少具有：

- 创建/启动、查询状态、取消；
- 读取公开 transcript；
- 读取模型阶段、工具开始/结束、Artifact、token/费用；公开用量同时保留 `input/output/cacheRead/cacheWrite`，前端以 `cacheRead / (input + cacheRead)` 显示提示缓存复用率；
- 向正在运行的 Session 排队一条教师/学生消息，当前工具结束后进入下一个 Pi turn；
- 同一 `session_ref` 续接时读取原 Pi JSONL，而不是重建单轮调用；
- 隐藏 reasoning 正文，只投影“推理中”和公开 assistant/tool 事件。

内容工坊的 KTQ/ER run 卡、教师复核记录、Teaching 对话都跳转到同一种 Session 详情视图。内容页可在运行中继续浏览；教师发送的引导消息进入队列并记录 actor，不修改历史结果。教学页直接把该投影渲染为对话流。

> **页面与内容工坊当前实现**：学生端和教师端已按用户任务重建信息架构，内容工坊与 Session 会话共用统一交互语言，并完成以下流程：
>
> - 文件入口支持拖放和点击选择；再次添加会追加，可逐项移除或清空；已删除内部“章节 ID”输入。
> - 上传只保存原始资料并建立待确认任务；用户确认之后才启动 KTQ。Agent 先观察原件，再按 `ocr-routing` Skill 自主决定是否调用 PaddleOCR。
> - 确认后由持久化状态机自动执行 KTQ → ER → 教师复核；KTQ 与 ER 使用两个独立 Session、独立工作区与 transcript。ER 会重新装配同批原件/已有 OCR Artifact，并把 KTQ 的已验证 `output` 复制为只读证据；不会继承 KTQ 对话历史。
> - Session 详情按 assistant 回合渲染为 Chatbox，并在回合内归并工具动作；逐 token `model_update` 不进入公开投影。
> - 内容流水线、两个 Session 引用和公开事件均从服务器恢复，浏览器刷新或离开后返回不会丢失；服务进程重启通过受限恢复函数扫描未完成流水线。
>
> 全站已按学生/教师任务拆分一级导航并统一 App Shell、Chatbox、响应式断点和霞鹜文楷字体。最终运行镜像已通过手机、平板、桌面无横向溢出的浏览器截图回归；文件入口同时覆盖键盘 Enter 触发、连续追加与拖放追加。Session 侧栏和每回合附注显示公开 token 用量与提示缓存复用率，隐藏 reasoning 正文。

### 6.1 Session Capsule 与存储生命周期

数据库、工作区和 Pi JSONL 仍是职责不同的三层存储，但结束动作由同一 Capsule 索引统一审计：

1. 每轮记录输入 Artifact 引用、前序 Session 证据引用和内联上下文文件；
2. 结束前为工作区文件生成路径、字节数、SHA-256 与保留类别清单；
3. 成功的终结型 Session 保留任务、公开事件、验证结果、receipt 与已发布 Artifact，释放可从正式 Artifact 重建的 `input` 副本、`tmp` 和发布前候选副本；
4. 所有真正终态的 Pi JSONL（KTQ、ER、Teaching 最终决策、Continuity、Dream、Plan）压缩进入 `.agent/capsule/transcripts/` 后删除散落原文件；领域 API 只返回 `capsule://` 不透明引用，前端继续读取公开事件投影；
5. 失败现场连同原始 Pi JSONL 完整保留 72 小时。只有带 `mathpilot.session-capsule-state/v1` 标记且到期的失败工作区会由 GC 先归档 transcript，再释放输入副本、临时文件和发布前候选；现有旧 Session 和未标记目录不会自动清理；
6. Teaching 的继续型 Session 在业务会话开放期间保留输入，回合结束释放 `tmp` 与发布前候选；`teach_summary` 是同一 Teaching Session 的继续回合，`session_decision` 才是本题终态。题目、程序画像、状态和历史在每轮重新按事实装配。

Capsule 清单提供“运行时曾看见什么”的审计证据，但不把被释放的输入副本当成唯一数据源。原始上传资料继续由内容 Artifact 存储负责，正式业务结论继续由 PostgreSQL 负责。

## 7. 多题连续学习上下文

每题关闭时必须同时形成两个有边界的意见：

1. **SER**：传统程序意见，含 BKT 基准、独立观测数、参数集、计算引用；
2. **TSS**：教学模型意见，描述本题过程、方法和未决项，不下长期画像结论。

进入下一题时，Teaching Prompt 注入：

- **固定程序拼装**的简要学生画像；
- **固定程序拼装**的当前学习状态：本轮用时、连续作答题数、提示依赖、复测/错因状态；
- `rolling_summary`：此前连续题目的递归摘要。

递归摘要是第三个独立产物 `ContinuitySummary`，由**辅助模型**在当前题的 SER/TSS 均已落地后生成。它既不是主模型 TSS，也不是传统程序 SER，更不能替代 Dream。输入必须包含此前累计摘要、当前 Session 完整公开会话和当前 SER/TSS：

```text
continuity_n = AuxModel.compress(
  continuity_(n-1),
  full_public_transcript_n,
  SER_n,
  TSS_n
)
```

因此第 n 题看到的不是整段无限 transcript，也不是只看第 n-1 题；它看到有长度预算、可追溯引用的前 n-1 题累计摘要。`continuity_(n-1)` 已包含更早全部题目的压缩信息，不做摘要字符串拼接。原始会话、SER、TSS 和每一版 ContinuitySummary 均单独留库；连续摘要只用于下一题教学上下文，不直接写掌握度。短画像/即时状态全部由程序读取权威字段后拼装，禁止模型补事实。

## 8. 安全与费用

- SCNET、PaddleOCR、Search 凭据只在对应宿主 Provider/MCP 子进程环境中出现；事件、工作区和 Artifact 不记录密钥。
- Core/Bash 保持无网络；PaddleOCR MCP 仅挂载当前工作区只读输入并允许访问官方 API；Search 不挂载工作区。
- OCR 与 Search 都是模型自主选择的付费/外部能力，前端显示调用状态和用量；批量内容任务必须有显式教师确认和预算门。
- Qwen-MM `api` 永不注册；主模型图像直接进入 SCNET。

## 9. 验收门

1. 任意任务 Session 能枚举同一组 Bash/Core/PaddleOCR/Search/respond 工具与可见 Skill 索引；数据库只表现为 Bash 环境、标准客户端和 database Skill，不出现专用数据库工具。
2. 无 key 时能力报告为 `unconfigured`，任务可明确失败/降级，不伪造输出；有 key 时密钥不出现在 Bash `env`、事件或 Session JSONL。
3. 用同一图片验证“原图直接观察”和“OCR + bbox + Core 局部复核”两条路径；草稿辅助线不会因 OCR 文本缺失而丢失。
4. KTQ/ER 分别为独立 Pi Session，但均可查看原件、OCR、既有库并拥有完整工具；ER 只读冻结 KTQ 与 KTQ output 证据，不能污染前序结果。
5. 教师在运行中能查看事件并排队引导；教学页能显示多轮回复、工具步骤、卡片和 Artifact。
6. 第二题 Prompt 含辅助模型基于第一题完整会话 + SER/TSS 生成的 ContinuitySummary；第三题使用 `continuity_1 + 第二题完整会话 + SER/TSS` 生成新的单份递归摘要；每版摘要引用能回到原记录。
7. Agent 可自行编写只读 SQL，但数据库身份无法跨租户、读取未授权表、改变作用域或修改正式表。
8. 每个正式 Skill 都有 frontmatter、Agent 元数据、模板和确定性验证器；有效夹具通过、损坏夹具失败。KTQ/ER 的 `respond` 引用文件与 receipt，Runtime 对同一文件独立复验。
9. `agent_end` 后 Runtime 有界关闭并释放 Session；`session_shutdown` 丢失不得无限阻塞业务请求，容器 init 负责回收 MCP/Bubblewrap 子进程。
10. 结束后的 Session 产生 Capsule 清单；全部成功终态归档 transcript 并释放重复 input/tmp，失败现场在保留期内可查，到期 GC 先归档 transcript 且只处理带版本标记的目录。
