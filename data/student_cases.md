# 学生诊断案例（交付物 #6：3 个完整案例）

> 案例由系统确定性黄金数据产生（deploy/dev/seed_gen.py 生成并灌入，ID 与数据库中
> 记录一一对应，可在报告/计划页直接查看）。每条案例含：画像 → 逐题作答与判定 →
> 错因追问（卡片/跳过/待观察）→ 程序基准（SER）与教学总结（TSS）双产物 →
> Dream 画像 Decision → 快照 → 学习计划。
>
> 无模型 key 时案例以黄金数据演示（§17.2）；接入真实模型后同一流程由系统实跑产生。

---

## case_001 — 基础薄弱型（usr_student02，高一 60→90）

**学生画像**：高一 / 当前分 60 / 目标分 90 / 每周 4-6 小时 / 无草稿设备 / 自认薄弱：正弦定理公式适用条件不清（K_SINE_RULE）

### 测评对话（逐题证据）

**第 1 题 Q_BAS_003**（正弦定理求边，A=60°，B=45°，b=2√2，求 a）— Session `s_demo_02a`

| 轮次 | 内容 | 判定（judgment） |
|---|---|---|
| 作答 | “a/sin60° = 2√2/sin45° → a = 2√2·(√3/2)/(√2/2)·(1/2)，算得 a=√3。” | 部分正确 `jud_demo_02a_1`：评分点 setup_sine_rule **达成**；solve_side **未达成**（sin45° 值或约分错误，正确答案 2√3） |
| 追问卡 | “sin45° 与 sin60° 的值分别是多少？重算 a 的值。”（`card_demo_02a`） | 学生**跳过**（只记录事件，不产生失败观测）→ claim `clm_demo_02a` skipped |

观测（按评分点写维度，P0-6）：`obs_s_demo_02a_1` K_SINE_RULE success（列式达成）；`obs_s_demo_02a_2` T_ANGLE_SOLVE failure（运算未达成）。错因候选：E_COMPUTE_SLIP(0.6)、E_FORMULA_MISUSE(0.4)。

**第 2 题 Q_BAS_002**（SSA 两解讨论，a=4，b=4√2，A=30°）— Session `s_demo_02b`

| 轮次 | 内容 | 判定 |
|---|---|---|
| 作答 | “sinB = b·sinA/a = √2/2，所以 B = 45°。” | 不正确 `jud_demo_02b_1`：列式达成；补角分支未达成（漏 135°） |
| 追问卡 | “sinB=√2/2 时 B 的可能值有哪些？”（`card_demo_02b`） | 未作答 → claim `clm_demo_02b` **unresolved（待观察）** |

观测：`obs_s_demo_02b_1` K_SSA failure（补角遗漏）；`obs_s_demo_02b_2` T_SSA_BRANCH success（列式）。错因候选：E_SSA_MISSING_OBTUSE(0.9)。

### 程序基准与教学总结（双产物）

| Session | SER（p_bkt_baseline，prior_only） | TSS |
|---|---|---|
| s_demo_02a | `ser_demo_02a` K_SINE_RULE 0.659 | 正弦定理比例式写出，代入时 sin45° 值用错导致结果偏差；追问卡跳过，证据留待后续会话确认 |
| s_demo_02b | `ser_demo_02b` K_SSA 0.051 | 能由正弦定理解出 sinB=√2/2，但只取 45° 一个解，遗漏 135° 补角；追问未答，错因待观察 |

### 画像 Decision（Dream，`pud_demo_02`）→ 快照 `snap_demo_02`

| 维度 | 基准 | P_profile | 状态 | 依据 |
|---|---|---|---|---|
| K_SINE_RULE | 0.659 | 0.491 | 证据不足（1 题独立） | TRANSFER_FAILURE_DISTINCT_CONTEXT lr=0.5：列式正确但运算/分类不稳 |
| K_SSA | 0.051 | 0.026 | 证据不足（1 题独立） | TRANSFER_FAILURE_DISTINCT_CONTEXT lr=0.5：补角遗漏且追问未闭合 |

错因：E_SSA_MISSING_OBTUSE **suspected**、E_COMPUTE_SLIP **suspected**。

### 学习计划 `pln_usr_student02`（4 周）

知识补讲（正弦定理与特殊角）→ 低一档练习 → SSA 分类讨论专项 → 延迟复测（每周预算 4-6h = 8 原子/周）。

---

## case_002 — 分类讨论不全型（usr_student01，高二 95→115）

**学生画像**：高二 / 当前分 95 / 目标分 115 / 每周 7-10 小时 / 触屏手写 / 自认薄弱：SSA 解的个数讨论（K_SSA）

### 测评对话（逐题证据）

**第 1 题 Q_TRI_012**（a=√3，b=2，A=30°，求角 B）— Session `s_demo_01a`

| 轮次 | 内容 | 判定 |
|---|---|---|
| 作答 | “由正弦定理 sinB = b·sinA/a = 1/√3，故 B ≈ 35.3°。” | 部分正确 `jud_demo_01a_1`：列式达成；补角分支未达成（遗漏 144.7°） |
| 追问卡 | “sinB=1/√3 时 B 的可能值有哪些？”（`card_demo_01a`） | “sinB=1/√3 时 B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°。”→ **正确** `jud_demo_01a_2` → claim `clm_demo_01a` **resolved** |

观测：`obs_s_demo_01a_1` K_SINE_RULE success；`obs_s_demo_01a_2` K_SSA failure；探针 `obs_s_demo_01a_3` K_SSA success（teaching_only，不独立）。错因：E_SSA_MISSING_OBTUSE(0.85)。

**第 2 题 Q_TRI_020**（a=2，b=2√2，A=30°）— Session `s_demo_01b`

| 轮次 | 内容 | 判定 |
|---|---|---|
| 作答 | “sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°。” | **正确** `jud_demo_01b_1`（两评分点均达成） |

观测：`obs_s_demo_01b_1` K_SINE_RULE success；`obs_s_demo_01b_2` K_SSA success。

### 程序基准与教学总结（双产物）

| Session | SER | TSS |
|---|---|---|
| s_demo_01a | `ser_demo_01a` K_SSA 0.051 | 能独立列出正弦定理并解出 sinB=1/√3，但第一次遗漏 SSA 补角分支；补角判断题卡作答正确后自行修正 |
| s_demo_01b | `ser_demo_01b` K_SSA 0.194 | 独立完成 SSA 两解讨论，正确给出 45° 与 135° 并验证存在性；分类讨论习惯已建立 |

### 画像 Decision（Dream，`pud_demo_01`）→ 快照 `snap_demo_01`

| 维度 | 基准 | P_profile | 状态 | 依据 |
|---|---|---|---|---|
| K_SSA | 0.194 | 0.491 | 学习中 | TRANSFER_SUCCESS lr=2.0（次题独立两解讨论）+ SELF_CORRECTION lr=2.0（追问后自行修正） |
| K_SINE_RULE | 0.897 | 0.958 | 可能掌握 | TRANSFER_SUCCESS lr=2.0 + METHOD_STABLE lr=1.3（两题列式稳定） |

错因：E_SSA_MISSING_OBTUSE **confirmed**（追问闭合 + 次题独立成功）。

### 学习计划 `pln_usr_student01`（4 周）

SSA 分类讨论专项（原难度练习）→ 正弦定理迁移题 → 延迟复测（每周预算 7-10h = 14 原子/周）。

---

## case_003 — 基础较好冲高分型（usr_student03，高三 120→135）

**学生画像**：高三 / 当前分 120 / 目标分 135 / 每周 10+ 小时 / 纸面拍照 / 自认薄弱：最值取等条件遗漏

### 测评对话（逐题证据）

**第 1 题 Q_EXT_003**（a+b=8，C=60°，求 c 最小值）— Session `s_demo_03a`
作答：“c²=(a+b)²−3ab ≥ 64−3·16=16，a=b=4 时取等 → c_min=4。”→ **正确** `jud_demo_03a_1`。观测：`obs_s_demo_03a_1` K_INEQUALITY success、`obs_s_demo_03a_2` T_INEQUALITY_APPLY success。

**第 2 题 Q_EXT_009**（a+b+c=6，C=60°，求面积最大值）— Session `s_demo_03b`
作答：“c²=a²+b²−ab ≥ (a+b)²/4 → c≥2，a=b=2 时取等 → S_max=√3。”→ **正确** `jud_demo_03b_1`。观测：`obs_s_demo_03b_1` T_MAX_MIN success、`obs_s_demo_03b_2` K_INEQUALITY success。

**第 3 题 Q_EXT_004**（a+b=10，C=60°，求面积最大值）— Session `s_demo_03c`

| 轮次 | 内容 | 判定 |
|---|---|---|
| 作答 | “S=√3ab/4，a+b=10 → ab≤25 → S≤25√3/4。” | 部分正确 `jud_demo_03c_1`：面积表达达成；不等式取等未验证（未说明 a=b=5 可达） |
| 追问卡 | “a=b=5 时 C=60° 的三角形存在吗？验证取等。”（`card_demo_03c`） | “a=b=5、C=60° 时 c=5，构成等边三角形 ✓，取等可达。”→ **正确** → claim `clm_demo_03c` **resolved** |

观测：`obs_s_demo_03c_1` K_TRIANGLE_AREA success、`obs_s_demo_03c_2` T_INEQUALITY_APPLY failure（取等未达成）、探针 `obs_s_demo_03c_3` K_TRIANGLE_AREA success（不独立）。错因：E_RANGE_END_MISS(0.8)。

### 程序基准与教学总结（双产物）

| Session | SER | TSS |
|---|---|---|
| s_demo_03a | `ser_demo_03a` K_INEQUALITY 0.897 | 余弦定理展开后直接用基本不等式求下界，取等条件说明完整（a=b=4），一次通过 |
| s_demo_03b | `ser_demo_03b` K_INEQUALITY 0.975 | 周长条件下的面积最值，不等式与取等处理一次通过（a=b=2） |
| s_demo_03c | `ser_demo_03c` K_TRIANGLE_AREA 0.659 | 面积上界算出但取等条件 a=b=5 未验证可达；追问后确认取等成立，结论修正为 25√3/4 |

### 画像 Decision（Dream，`pud_demo_03`）→ 快照 `snap_demo_03`

| 维度 | 基准 | P_profile | 状态 | 依据 |
|---|---|---|---|---|
| K_INEQUALITY | 0.975 | 0.99 | 可能掌握 | TRANSFER_SUCCESS lr=2.0 + METHOD_STABLE lr=1.3（三题配凑独立正确） |
| T_INEQUALITY_APPLY | 0.194 | 0.238 | 薄弱 | METHOD_STABLE lr=1.3：最值题型方法稳定但取等验证环节遗漏一次 |

错因：E_RANGE_END_MISS **improving**（追问闭合，取等习惯养成中）。

### 学习计划 `pln_usr_student03`（4 周）

不等式/最值取等专项（含取等验证习惯）→ 综合迁移 → 限时训练（每周预算 10+ 小时 = 20 原子/周）。

---

## 数据文件

- `data/student_cases.csv`：结构化摘要（六表之一）。
- 其余五表（知识点/题型/错因/题目/诊断规则）由 `deploy/dev/export-data.sh` 从数据库派生导出。
- 案例可复现：`docker compose up` 后灌入种子（deploy/dev/seed.sql）即得上述全部记录。
