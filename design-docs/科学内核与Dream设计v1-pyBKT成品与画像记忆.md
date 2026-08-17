# 科学内核与 Dream 设计 v1：pyBKT 成品 + 画像记忆

> 日期：2026-08-18  
> 依据：`系统设计v3.3` §9（量化三层）、§11（画像系统）；`架构修订v4` §3（成品复用：pyBKT Roster = Dream 成品、OATutor 引擎已移植）；`references` 调研。  
> 性质：把"科学方案欠缺"落到可执行规格；Hermes/OpenClaw 记忆系统借鉴在 §6 补入。

---

## 0. 分层回顾（v3.3 §9.1）

```text
M_k  掌握层：习得概率（BKT）          → OATutor 引擎（TS，实时） + pyBKT（校准/批量）
R_k  保持率层：当前可提取性（艾宾浩斯）→ I90 网格后验（自建，无成品）
C_e  错因层：证据状态                 → 证据集合 + 六档状态（v3.3 §9.7）
P    画像层：Dream 大模型最终更新      → 双产物 + pyBKT Roster 程序基准 + Validator（v3.3 §9.3）
```

三层不得混成一个数：时间衰减不改写 M（§9.6）；运算错误不直接等价概念掌握（§8.1）；提示后成功不算独立证据（§8.2）。

## 1. 掌握层：双引擎分工

### 1.1 实时引擎（TS，已落地 commit a46ce89）

`packages/mastery` 为 OATutor BKT-brain.js 移植：`bktUpdate`（标准贝叶斯后验 + 参数化学习转移）、`bktReplay`、`masteryState`（0.4/0.8/0.95 门槛，MASTERY_THRESHOLD=0.95 为 OATutor 约定）。learning/review 每次观测即时重放，零侧车延迟。

### 1.2 pyBKT 侧车（Python，ADR-001 侧车规范）

- **角色**：批量校准（fit/partial_fit）与画像级掌握度（`models.Roster`）——Dream 路径的程序基准；
- **部署**：nix dev 环境（flake 增加 python312 + gcc + LD_LIBRARY_PATH；`sidecars/pybkt/setup.sh` 建 venv 并钉版：numpy<2、scikit-learn<1.6；含一处受控 venv 补丁——pyBKT 纯 Python fit 路径的 numpy 广播 bug，不改克隆仓库）；
- **契约**：薄 CLI 包装，stdin JSON-lines → stdout JSON，无状态、无数据库访问：

```text
sidecars/pybkt/
  cli.py        # 操作分发：fit | partial_fit | predict | roster_update | roster_get
  roster.py     # pyBKT models.Roster 包装（update_state / get_mastery_prob）
```

```jsonc
// 请求行（每行一个操作）
{"op":"roster_update","student_id":"usr_01","dimension_id":"K_SSA","outcome":"success","order_id":"obs_..."}
{"op":"roster_get","student_id":"usr_01","dimension_id":"K_SSA"}
{"op":"fit","parameter_set_id":"bkt_cal_v1","rows":[{"student_id":"...","dimension_id":"...","outcome":"success|failure","order_id":"..."}]}

// 响应行
{"ok":true,"value":{"p_mastery":0.71},"parameter_set_id":"bkt_prior_v1"}
```

- 数据契约沿用 pyBKT 默认列语义：`correct ∈ {-1 未作答, 0 错, 1 对}`；`dimension_id` 映射 skill_name；`order_id` 映射 order_id（全链路幂等，§15.2）。

### 1.3 校准流程（prior_only → calibrated，v3.3 §9.2）

1. 教学阶段始终用 TS 引擎 + 版本化先验参数集（`bkt_prior_v1`，`prior_only` 标注进 SER）；
2. 积累足够真实序列（阈值入实验参数）后，离线 `fit`（multigs/multilearn/forgets 变体）生成新参数集，升 `parameter_set_id` 并标记 `calibrated`；
3. 参数集变更按版本管理（§14.3），可重放可比较。

## 2. 保持率层：I90 网格（自建，v3.3 §9.6）

无成品（OATutor 无时间衰减、pyBKT forgets 非时间层）——必须自建，公式已冻结：

```text
I90 ∈ {0.5,1,2,4,8,16,32,64} 天
R(Δt|I90) = 0.9^(Δt/I90)
P(y=1|I90,Δt,q) = G_q + (1-G_q-S_q)·R(Δt|I90)
posterior(I90_i) ∝ prior(I90_i)·P(y|I90_i,Δt,q)
```

- 只由独立延迟复测更新；复测时间 = 平均保持率首降 <0.85 时刻；
- 数据不足显示"复测估计不稳定"，不伪造日期；
- 落点：`packages/mastery` 增加 `retention.ts`（纯函数 + 状态表 `state_retention_state` 已建）。

## 3. 错因层（v3.3 §9.7，已冻结）

证据集合六档（suspected/confirmed/improving/resolved/superseded），排序分 = 证据数×置信×时效×相关度，展示可展开到原始证据。表 `state_misconception_state` 已建；Dream 决策的 `misconceptions` 输出物化于此。

## 4. Dream 画像：pyBKT Roster 成品 + 大模型最终更新

```text
SLR 窗口（双产物）
  → pyBKT Roster（侧车）：逐学生×逐维度 p_mastery 程序基准（替代手写 bktReplay 全量重算）
  → EvidenceBundle：双产物 + Roster 基准 + 错因/保持率状态 + 证据索引
  → Dream/Profile Update Agent（独立 Session，policies/dream-profile skill）
      ：综合基准与跨题语义 → ProfileUpdateDecision（p_baseline 引用 Roster 输出，LR 账本，§9.4）
  → Validator（引用/LR/算术/双 Session，不变）→ 物化 StudentSnapshot + mastery_state + retention/misconception 状态
```

- Roster 的 0.95 阈值与 OATutor MASTERY_THRESHOLD 一致，只作程序报告标注；
- Dream 窗口语义不变（§11.3 触发器可配置）；教师纠正 supersede + 重放路径不变（review-service），重放后的修订 SER 重新进入 Dream 窗口。

## 5. 数据表落点（已建，无需迁移）

`state_scientific_evaluation_report`（SER）、`state_retention_state`（I90 后验 + next_review_due）、`state_misconception_state`（错因六档）、`state_student_snapshot` / `state_mastery_state`（快照/掌握）、`state_profile_evidence_bundle` / `state_profile_update_decision` / `state_profile_decision_validation`（Dream 链）。

## 6. 记忆系统借鉴（OpenClaw 调研已定稿；Hermes 补入 6.2）

来源：`reference/openclaw/`（v2026.8.1，与 pi 同生态——共享 pi-tui，运行时自研；借鉴其架构模式而非代码）。

### 6.1 OpenClaw 记忆架构 → AGMATH 画像映射

OpenClaw 记忆五原则：①无隐藏状态（纯文件 + 索引，编辑器可查）②**写入是难点**——策展移出回复路径进后台整理 ③写路径是安全边界（写入时强制血缘）④**确定性门内做模型判断** ⑤失败不阻塞回复。

| OpenClaw 层 | AGMATH 映射 |
|---|---|
| Instructions（AGENTS.md，常注入） | policies/ + 工作区 AGENTS.md（已有） |
| Curated core（MEMORY.md/USER.md，预算内常注入） | **每学生 `STUDENT.md` 投影**：快照维度 + 待办 + 复测到期，只读投影注入教学 Session（§5.1 student/ 挂载） |
| Episodic（daily notes + 会话转录，**从不自动注入，按需检索**） | 每 Session 证据记录（观测/判定/草稿引用），Teaching Agent 按需检索（§5.3 文件层） |
| Prospective（standing intents + cron，触发时注入） | 复测调度（state_review_schedule：I90 到期触发） |
| Review（DREAMS.md + 报告，**人类阅读**） | **教师复核报告**：Dream 生成人类可读证据报告（pre-image + 来源），教师读报告而非原始转录 |

**直接可用的四条纪律**：

1. **回忆回路防复发（recall-loop prevention）**：注入过上下文的内容打标、绝不重新抽取为记忆——对应 v3.3 §9.4"单题对错已进 BKT 后不得再用同一对错直接调整"（防双计数在记忆层的一致性表达）；
2. **来源类别（owner/agent/untrusted/system）**：对应证据归因——学生原始作答=owner、教师推断=agent、外部资料=untrusted、系统事件=system；写入时强制；
3. **flush-before-compact**：Session 关闭前强制证据落盘回合（handoff 内容先写再总结），保证摘要不吞证据——对应 §11.4 连续性包；
4. **失败不阻塞回复**：教学 Session 读取画像投影设预算（15s 级检索上限 + 熔断 + 缓存），学生状态召回优雅降级，不吞回合。

**检索评分栈**（evidence 按需检索用）：关键词+向量混合 × 重要性(1-10) × MMR 多样性 × **时间衰减（半衰期可配）**——对应错因排序分（证据数×置信×时效×相关度，§9.7）与 Dream 证据索引排序。

**版本化状态**：逐学生 SQLite + 只追加迁移 + schema 版本号 + doctor 修复契约——对应 snapshot 版本链（§11.3 唯一 snapshot_id）与既有迁移纪律。

**手off 显式链路**：旧 Session → 新 Session 的 upstream-link 记录 + 紧凑证据载荷——对应 §11.4 连续性包（handoff.md 显式引用上一题证据）。

### 6.2 Hermes 记忆系统借鉴（调研定稿）

来源：`reference/hermes-agent/`（三层记忆：策展 MEMORY.md/USER.md + 外部 provider 生命周期 + SQLite 会话事件库）。

**三层映射到 AGMATH 画像**：

| Hermes 层 | AGMATH 映射 |
|---|---|
| 策展记忆（MEMORY.md/USER.md，有界、人类可编辑） | **每学生 STUDENT.md 画像卡**（维度掌握 + 错因 + 复测到期，预算内注入）|
| 会话事件库（SQLite + FTS5，原始证据） | runtime 证据表（观测/判定/草稿引用，按需检索）|
| 外部 provider 生命周期（prefetch → sync） | 教学 Session 打开时预取画像投影、关闭时写证据 |

**直接采纳的五条机制**：

1. **冻结快照模式（frozen snapshot）**：Session 开始时的画像投影进入 systemPrompt 后**冻结**，会话中写入不改变提示（前缀缓存稳定），下次 Session 刷新——对应我们"题间只传递结构化连续性包 + 快照摘要"（§1.1-7），投影只读；
2. **写门（allow/block/stage）**：写入需要审批，staged 写入由审批者回放——对应 ADR-004"StudentSnapshot 只由通过校验的 PUD 物化"与教师 supersede：程序只出基准、大模型出决策、教师改判走 stage/approve 语义；
3. **Curator（Hermes 的 Dream）**：**确定性规则通过先做，LLM 整理为 opt-in 层**（默认关）、间隔+空闲门控、归档不删除、结构化 YAML 决策（from/into/reason）、运行前快照、dry-run 报告——**我们的 Dream 首版应以确定性证据规约（六档错因、supersede 链、双产物配对校验）为基线**，LLM 整理层可 dry-run、可审查（v3.3 §11.3 已一致，此处给出实现次序）；
4. **记忆卫生（durable facts only）**：只存持久声明性事实，任务进度/7 天内过期物不入记忆；过程性知识归 skills——对应画像只存掌握/保持率/错因状态，不存"今天做了第 3 题"（§11.4 连续性包另存）；
5. **FTS5 确定性检索足矣（无需嵌入向量）**：结构化掌握事实用确定性 SQL 检索 + 有界策展卡，比向量库更可审计——对应教学阶段证据查询与错因排序分（§9.7）。

**保留差异**：Hermes 每会话持久化原始转录；AGMATH 的事实层只存事件索引（对象存储在阶段 B），不保存模型隐藏推理（§16.5 可回放 ≠ 保存思维链）。
