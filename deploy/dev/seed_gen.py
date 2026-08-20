#!/usr/bin/env python3
"""MathPilot dev 种子生成器（P0-1：K≥25/T≥20/E≥20/Q≥80/R≥20 + 3 个完整学生案例）。

生成 deploy/dev/seed.sql（幂等：全部 on conflict do nothing / do update）。
数据来源：附件 01-05 解三角形专题（docs/数据整理说明.md 逐项说明）；题目按专题
自建/改编，数值经人工验算。

设计对齐（P0-6/P0-8）：
- 观测按评分点写维度：主答 rubric met→success / not_met→failure；
  探针 teaching_only 不独立；观测携带 judgment_id + evidence_refs；
- SER p_baseline 用与 packages/mastery 相同的 BKT 公式重放计算（prior_only）；
- 快照 state 与 masteryState(p, 观测数) 一致；PUD 带证据账本与 ≥2 会话引用；
- 学习计划按每周预算排布（planner.ts 同构：每周原子数 = 分钟/30，任务只在 1..horizon）。

用法：python3 deploy/dev/seed_gen.py > deploy/dev/seed.sql
"""

from __future__ import annotations

import json
import math as _math

TENANT = "tnt_dev00001"
TEACHER = "usr_teacher01"
NOW = "2026-08-18T00:00:00Z"

# ─────────────────────────── BKT 数学（与 packages/mastery 同构） ───────────────────────────

PRIOR, SLIP, GUESS, TRANSIT = 0.3, 0.1, 0.2, 0.0


def bkt_update(p: float, outcome: str) -> float:
    if outcome == "success":
        num = p * (1 - SLIP)
        den = num + (1 - p) * GUESS
    else:
        num = p * SLIP
        den = num + (1 - p) * (1 - GUESS)
    return (num / den) + (1 - num / den) * TRANSIT


def bkt_replay(outcomes: list[str]) -> float:
    p = PRIOR
    for o in outcomes:
        p = bkt_update(p, o)
    return round(p * 1000) / 1000  # 与 learning 的 Math.round(p*1000)/1000 一致



def logit(p: float) -> float:
    c = max(min(p, 1 - 1e-6), 1e-6)
    return _math.log(c / (1 - c))


def mastery_state(p: float, count: int) -> str:
    if count < 2:
        return "insufficient_evidence"
    if p < 0.4:
        return "weak"
    if p < 0.8:
        return "learning"
    return "possibly_mastered"  # 无迁移证据不标 mastered


# ─────────────────────────── 章节与 K/T/E/R 数据 ───────────────────────────

CHAPTERS = [
    ("chap_01", "解三角形·正余弦定理与基本应用"),
    ("chap_02", "解三角形·中线、角平分线与高线"),
    ("chap_03", "解三角形·外接圆、内切圆与多三角形"),
    ("chap_04", "解三角形·最值与范围"),
    ("chap_05", "解三角形·定理与模型"),
]

# (id, 模块, 名称, 掌握标准, 补弱建议)
KNOWLEDGE = [
    # ── 专题一：正余弦定理与基本应用 ──
    ("K_SINE_RULE", "正余弦定理与基本应用", "正弦定理", "能在任意三角形中列出并解正弦定理方程", "熟记 a/sinA=b/sinB=c/sinC，先找两边两角"),
    ("K_COSINE_RULE", "正余弦定理与基本应用", "余弦定理", "能由两边夹角或三边求第三边/角", "记 a²=b²+c²−2bc·cosA，注意符号"),
    ("K_TRIANGLE_AREA", "正余弦定理与基本应用", "三角形面积公式", "能用 S=½bc·sinA 计算面积", "面积含 ½ 与 sinA，勿漏"),
    ("K_SHAPE_JUDGE", "正余弦定理与基本应用", "三角形形状判断", "能由边角关系判断等腰/直角/等边", "优先边化角或角化边统一再判断"),
    ("K_TRIANGLE_EXISTENCE", "正余弦定理与基本应用", "三角形存在条件", "能判断给定条件是否构成唯一/两解/无解", "SSA 必须讨论补角分支与 A+B<180°"),
    # ── 专题二：中线、角平分线与高线 ──
    ("K_MEDIAN", "中线角平分线高线", "中线长公式", "能用 m_a=½√(2b²+2c²−a²) 求中线", "中线公式与重心 2:1 分点结合"),
    ("K_ANGLE_BISECTOR", "中线角平分线高线", "角平分线", "能用角平分线定理 BD/DC=AB/AC", "角平分线长公式与比例定理分用"),
    ("K_ALTITUDE", "中线角平分线高线", "高线", "能用 h=2S/a 与底边对应关系求高", "高线对应底边不能张冠李戴"),
    ("K_ZHANG_ANGLE", "中线角平分线高线", "张角问题", "能用 tan 关系与和角公式解共顶点角", "张角两角之和为定角时列 tan 和角"),
    ("K_EQUAL_AREA", "中线角平分线高线", "等面积法", "能用一个面积两种表达建立方程", "同一三角形面积可写成多种底高组合"),
    # ── 专题三：外接圆、内切圆与多三角形 ──
    ("K_CIRCUMCIRCLE", "圆与多三角形", "外接圆", "能用 R=a/(2sinA) 求外接圆半径", "直径所对圆周角为直角可简化"),
    ("K_INCIRCLE", "圆与多三角形", "内切圆", "能用 r=S/s 求内切圆半径", "r=S/s，s 为半周长"),
    ("K_MULTI_TRIANGLE", "圆与多三角形", "多三角形拆分", "能把复杂图形拆成若干三角形分析", "公共边/公共角是拆分的桥"),
    ("K_COMMON_EDGE", "圆与多三角形", "公共边角转化", "能在共边两三角形间转化角与边", "互补角正弦相等、同弧圆周角相等"),
    ("K_RADIUS_RELATION", "圆与多三角形", "半径关系", "能处理 R 与 r 的比例/数量关系", "等边三角形 r=R/2，直角三角形 r=(a+b−c)/2"),
    # ── 专题四：最值与范围 ──
    ("K_ANGLE_TO_SIDE", "最值与范围", "角化边", "能把角条件化为边的条件", "正弦定理整式化，边化角同理"),
    ("K_SIDE_TO_ANGLE", "最值与范围", "边化角", "能把边条件化为角的条件", "边比化为正弦比，注意等价性"),
    ("K_INEQUALITY", "最值与范围", "基本不等式", "能用 ab≤((a+b)/2)² 求最值并写取等", "取等条件必须可达（三角形约束下）"),
    ("K_TRIG_RANGE", "最值与范围", "三角函数值域", "能求 sinA+sinB 等式的范围", "和积化积后用 |cos|≤1 夹逼"),
    ("K_EDGE_RANGE", "最值与范围", "边长范围", "能用三角不等式与正弦定理求边范围", "退化三角形处取开区间"),
    # ── 专题五：定理与模型 ──
    ("K_TANGENT_IDENTITY", "定理与模型", "正切恒等式", "能用 tanA+tanB+tanC=tanA·tanB·tanC", "A+B+C=π 时成立，注意分母为零"),
    ("K_SINE_SQUARE_DIFF", "定理与模型", "正弦平方差", "能用 sin²A−sin²B=sin(A+B)sin(A−B)", "平方差公式与和差化积联动"),
    ("K_POWER_OF_POINT", "定理与模型", "圆幂定理", "能用相交弦/割线/切割线定理", "切线长平方等于割线两段之积"),
    ("K_HIDDEN_CIRCLE", "定理与模型", "隐圆", "能从定角/定比识别隐圆轨迹", "∠APB 为定角 → P 在定圆弧上"),
    ("K_APOLLONIUS", "定理与模型", "阿波罗尼斯圆", "能由 PA:PB=定值求动点轨迹圆", "按比例平方展开配方成圆方程"),
    ("K_PTOLEMY", "定理与模型", "托勒密定理", "能对圆内接四边形用 AC·BD=AB·CD+BC·DA", "圆内接四边形对边乘积之和等于对角线乘积"),
]

# (id, 名称, 典型问法, 标准步骤, 评分点)
QUESTION_TYPES = [
    ("T_SSA_SOLVE", "SSA 解三角形", "已知两边一对角求另一对角", "正弦定理→sinB→讨论解数", "列出正弦定理；补角分支与存在性"),
    ("T_SSA_BRANCH", "SSA 两解讨论", "SSA 条件下判断解的个数并求两解", "sinB 值→B 的两组可能→验证 A+B<180°", "求 sinB；逐个验证解的合法性"),
    ("T_SIDE_SOLVE", "已知两边一角求边", "已知两边及夹角求第三边", "余弦定理直接代入", "套用余弦定理；开方取正"),
    ("T_ANGLE_SOLVE", "已知边求角", "已知三边求最大角/判定", "余弦定理求 cos 值", "选最大边对应角；余弦值定角"),
    ("T_AREA_COMPUTE", "面积计算", "已知两边夹角求面积", "S=½bc·sinA", "面积公式代入"),
    ("T_SHAPE_JUDGE", "形状判断", "由边角关系判断三角形形状", "统一为边或角→化简", "化统一；结论完整（等腰/直角/等边）"),
    ("T_MEDIAN_SOLVE", "中线长问题", "已知三边/两边夹角求中线长", "中线长公式或余弦两次", "公式代入；结果开方"),
    ("T_BISECTOR_SOLVE", "角平分线问题", "角平分线分边或求角平分线长", "比例定理/角平分线长公式", "比例式；长公式 2bc·cos(A/2)/(b+c)"),
    ("T_ALTITUDE_SOLVE", "高线问题", "求高线长或由高求面积", "h=2S/a 或三角形拆分", "底边对应正确"),
    ("T_EQUAL_AREA", "等面积法应用", "用等面积法建立方程", "同一面积两种表达", "两种表达相等；解方程"),
    ("T_CIRCUMCIRCLE_SOLVE", "外接圆半径", "求外接圆半径/直径", "R=a/(2sinA)", "正弦定理比值"),
    ("T_INCIRCLE_SOLVE", "内切圆半径", "求内切圆半径", "r=S/s", "面积与半周长"),
    ("T_MULTI_TRIANGLE", "多三角形", "复杂图形拆分为三角形求量", "找公共边/公共角拆分", "拆分完整；无遗漏重叠"),
    ("T_COMMON_EDGE", "公共边角", "共边两三角形间转化", "正弦定理+互补角", "角关系转化正确"),
    ("T_MAX_MIN", "最值范围", "求边/周长/面积的最值或范围", "边化角→三角函数范围；或不等式", "取等条件说明"),
    ("T_INEQUALITY_APPLY", "不等式应用", "用基本不等式求最值", "配凑 ab 定值", "取等可达性"),
    ("T_TRIG_FUNC_RANGE", "三角函数性质", "求三角表达式范围", "和差化积/辅助角", "值域边界"),
    ("T_TANGENT_IDENTITY", "正切恒等式", "三角形内角正切关系", "tan 和角公式", "恒等式适用条件"),
    ("T_POWER_AND_CIRCLE", "圆幂与隐圆", "圆幂定理/隐圆轨迹", "切割线/相交弦；定角轨迹", "识别模型"),
    ("T_PTOLEMY", "托勒密定理", "圆内接四边形求对角线", "托勒密定理", "对边配对正确"),
]

# (id, 错因大类, 名称, 表现形式, 判断依据, 补救建议)
ERROR_CAUSES = [
    ("E_SSA_MISSING_OBTUSE", "分类讨论不完整", "遗漏 SSA 补角分支", "只给锐角解，未讨论补角", "sinB 对应两角时仅取锐角", "补角判断卡：sinB=x 时 B 可能值"),
    ("E_SINE_AMBIGUITY", "分类讨论不完整", "正弦定理漏解或增解", "解数判断错误", "未验证 A+B<180° 或漏第二解", "逐解验证三角形存在性"),
    ("E_COSINE_SIGN", "公式误用", "余弦定理符号错误", "中间项符号错（+2bc 等）", "代入展开检查", "重抄公式 a²=b²+c²−2bc·cosA"),
    ("E_FORMULA_MISUSE", "公式误用", "正余弦定理公式混用", "求边用余弦、求角用正弦混用", "条件与公式不匹配", "按已知条件选定理"),
    ("E_AREA_HALF_MISS", "公式误用", "面积公式漏 ½ 或 sinA", "面积计算差 ½ 倍", "结果与单位检查", "S=½·a·b·sinC 三步走"),
    ("E_SHAPE_OVERGENERAL", "结论过度泛化", "形状判断过度泛化", "仅凭一角定为某形状", "条件不足以推出结论", "逐一验证边/角关系"),
    ("E_MEDIAN_FORMULA_ERR", "公式记忆错误", "中线长公式记错", "系数或减号错误", "公式检验：等边三角形自检", "m_a=½√(2b²+2c²−a²) 特例验证"),
    ("E_BISECTOR_RATIO_ERR", "比例误用", "角平分线比例定理误用", "BD/DC 写成边反比", "比例方向错误", "BD/DC=AB/AC 对应写清"),
    ("E_ALTITUDE_BASE_ERR", "对应错误", "高线底边对应错误", "高与底边不匹配", "面积=½·底·高 对不上", "画图标注底与高"),
    ("E_EQUAL_AREA_SETUP_ERR", "列式错误", "等面积法列式错误", "两种面积表达不等价", "表达式检查", "同一三角形面积写成两式"),
    ("E_CIRCUMRADIUS_ERR", "公式误用", "外接圆半径公式误用", "R=a/sinA 漏 2", "结果合理性检查", "R=a/(2sinA) 与正弦定理同源"),
    ("E_INRADIUS_AREA_ERR", "公式误用", "内切圆半径与面积关系误用", "r=S/s 用成 r=S/a", "数值验证", "r=S/s，s 为半周长"),
    ("E_MULTI_TRI_ANGLE_ERR", "对应错误", "多三角形公共角对应错误", "拆分后角度对应错", "几何图示核对", "拆分图画公共角标注"),
    ("E_RANGE_END_MISS", "取等条件遗漏", "最值取等条件遗漏", "给出范围不含取等说明", "未验证取等可达", "取等条件：变量取值必须落在定义域"),
    ("E_INEQUALITY_DIRECTION", "不等式误用", "基本不等式方向/取等误用", "用错 ≥/≤ 或取等不成立", "等号条件检验", "a+b 定值求 ab 最大，ab 定值求 a+b 最小"),
    ("E_TRIG_RANGE_UNBOUNDED", "范围误判", "三角函数值域误判", "sin+sin 范围写成 [0,2]", "未用和差化积", "sinA+sinB=2sin((A+B)/2)cos((A−B)/2)"),
    ("E_ANGLE_SIDE_CONVERT", "等价性破坏", "角化边/边化角等价性破坏", "无中生有引入比例", "变换可逆性检查", "只允许正弦定理整式变换"),
    ("E_TANGENT_DENOM_ZERO", "定义域遗漏", "正切恒等式分母为零", "tan 和角分母为零时硬套", "分母检验", "A+B=90° 时 tan 无定义"),
    ("E_HIDDEN_CIRCLE_MISS", "模型识别失败", "隐圆几何关系未识别", "定角条件未转轨迹", "角度恒定未用", "∠APB 定角→圆弧轨迹"),
    ("E_COMPUTE_SLIP", "运算粗心", "运算粗心错误", "中间步骤符号/数值错误", "结果与估算偏差大", "代入验算、量纲检查"),
]

# (id, 触发条件, 候选错因, 追问问题, 适用维度)
DIAGNOSIS_RULES = [
    ("R_SSA_BRANCH_CHECK", "sinB 值给出单一锐角解", ["E_SSA_MISSING_OBTUSE"], "sinB=x 时 B 的可能值有哪些？", ["K_SSA", "K_TRIANGLE_EXISTENCE", "T_SSA_BRANCH"]),
    ("R_SINE_AMBIGUITY_CHECK", "解数判断与存在性验证缺失", ["E_SINE_AMBIGUITY"], "两解都满足 A+B<180° 吗？逐个验证。", ["K_SSA", "K_TRIANGLE_EXISTENCE", "T_SSA_SOLVE"]),
    ("R_COSINE_SIGN_CHECK", "余弦定理展开中间项符号错误", ["E_COSINE_SIGN"], "把余弦定理重新展开：a²=b²+c²−2bc·cosA。", ["K_COSINE_RULE", "T_SIDE_SOLVE"]),
    ("R_FORMULA_MISUSE_CHECK", "已知条件与所用定理不匹配", ["E_FORMULA_MISUSE"], "这个条件应该用正弦还是余弦？为什么？", ["K_SINE_RULE", "K_COSINE_RULE", "T_ANGLE_SOLVE"]),
    ("R_AREA_HALF_CHECK", "面积结果与边长量级不符", ["E_AREA_HALF_MISS"], "面积公式写一遍，检查 ½ 与 sinA 是否都在。", ["K_TRIANGLE_AREA", "T_AREA_COMPUTE"]),
    ("R_SHAPE_JUDGE_CHECK", "仅凭单一条件断言形状", ["E_SHAPE_OVERGENERAL"], "这个条件能推出什么？还需要什么条件？", ["K_SHAPE_JUDGE", "T_SHAPE_JUDGE"]),
    ("R_MEDIAN_FORMULA_CHECK", "中线长公式系数/符号错误", ["E_MEDIAN_FORMULA_ERR"], "用等边三角形自检一遍中线公式。", ["K_MEDIAN", "T_MEDIAN_SOLVE"]),
    ("R_BISECTOR_RATIO_CHECK", "角平分线分边比例方向错误", ["E_BISECTOR_RATIO_ERR"], "BD/DC 应等于哪两条边的比？", ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"]),
    ("R_ALTITUDE_BASE_CHECK", "高与底边不对应", ["E_ALTITUDE_BASE_ERR"], "这个高对应哪条底边？面积两种写法一致吗？", ["K_ALTITUDE", "T_ALTITUDE_SOLVE"]),
    ("R_EQUAL_AREA_CHECK", "等面积两种表达不相等", ["E_EQUAL_AREA_SETUP_ERR"], "同一面积写两种表达式再相等。", ["K_EQUAL_AREA", "T_EQUAL_AREA"]),
    ("R_CIRCUMRADIUS_CHECK", "外接圆半径缺 2 倍", ["E_CIRCUMRADIUS_ERR"], "R 与 a、sinA 的关系式写全。", ["K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE"]),
    ("R_INRADIUS_CHECK", "内切圆半径用错半周长", ["E_INRADIUS_AREA_ERR"], "r=S/s 里 s 是什么？", ["K_INCIRCLE", "T_INCIRCLE_SOLVE"]),
    ("R_MULTI_TRIANGLE_CHECK", "拆分三角形角度对应错误", ["E_MULTI_TRI_ANGLE_ERR"], "画出拆分图，标注公共角，重新对应。", ["K_MULTI_TRIANGLE", "T_MULTI_TRIANGLE"]),
    ("R_RANGE_END_CHECK", "最值未验证取等条件", ["E_RANGE_END_MISS"], "取等条件成立吗？变量能取到吗？", ["K_INEQUALITY", "K_EDGE_RANGE", "T_MAX_MIN"]),
    ("R_INEQUALITY_DIR_CHECK", "不等式方向或取等误用", ["E_INEQUALITY_DIRECTION"], "a+b 与 ab 哪个是定值？方向写对了吗？", ["K_INEQUALITY", "T_INEQUALITY_APPLY"]),
    ("R_TRIG_RANGE_CHECK", "三角式范围超出实际值域", ["E_TRIG_RANGE_UNBOUNDED"], "用和差化积把 sinA+sinB 化开再求范围。", ["K_TRIG_RANGE", "K_SIDE_TO_ANGLE", "T_TRIG_FUNC_RANGE"]),
    ("R_ANGLE_SIDE_CONVERT_CHECK", "边角变换不可逆", ["E_ANGLE_SIDE_CONVERT"], "这个变换每一步都能逆回去吗？", ["K_ANGLE_TO_SIDE", "K_SIDE_TO_ANGLE", "T_ANGLE_SOLVE"]),
    ("R_TANGENT_DENOM_CHECK", "正切和角分母为零", ["E_TANGENT_DENOM_ZERO"], "tan(A+B) 的分母在什么情况下为零？", ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"]),
    ("R_HIDDEN_CIRCLE_CHECK", "定角条件未识别轨迹", ["E_HIDDEN_CIRCLE_MISS"], "角度恒定说明点 P 在什么曲线上？", ["K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE"]),
    ("R_COMPUTE_SLIP_CHECK", "结果与估算量级不符", ["E_COMPUTE_SLIP"], "把代入过程重新写一遍，逐行验算。", ["K_SINE_RULE", "K_COSINE_RULE", "T_SIDE_SOLVE"]),
]

# ─────────────────────────── 题目数据（82 道 = 80 新题 + 2 试点题，数值经人工验算） ───────────────────────────
# (id, chapter, primary K, secondary T, prerequisite K, tags,
#  stem, answer, r1_id, r1_desc, r2_id, r2_desc, [targets_override])
QUESTIONS = [
    # ── 试点题（chap_tri_pilot，演示基线；测量目标保持原始语义：SSA 补角为核心） ──
    ("Q_TRI_012", "chap_tri_pilot", "K_SSA", "K_SINE_RULE", "K_TRIANGLE_EXISTENCE",
     ["K_SINE_RULE", "K_SSA", "K_TRIANGLE_EXISTENCE"],
     "在△ABC中，已知 a=√3，b=2，A=30°。求角 B（注意讨论解的个数）。",
     "sinB = b·sinA/a = 1/√3，B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°。",
     "setup_sine_rule", "正确列出正弦定理并解出 sinB", "ssa_branch_check", "检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件",
     [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"},
      {"dim": "K_SINE_RULE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"},
      {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.existence_check"}]),
    ("Q_TRI_020", "chap_tri_pilot", "K_SSA", "K_SINE_RULE", "K_TRIANGLE_EXISTENCE",
     ["K_SINE_RULE", "K_SSA", "K_TRIANGLE_EXISTENCE"],
     "在△ABC中，已知 a=2，b=2√2，A=30°。求角 B（注意讨论解的个数）。",
     "sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°。",
     "setup_sine_rule", "正确列出正弦定理并解出 sinB", "ssa_branch_check", "检验 SSA 补角分支（两解讨论）并确认均满足三角形存在条件",
     [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"},
      {"dim": "K_SINE_RULE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"},
      {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.existence_check"}]),
    # ── 专题一：正余弦定理与基本应用（16） ──
    ("Q_BAS_001", "chap_01", "K_SINE_RULE", "T_SSA_SOLVE", "K_TRIANGLE_EXISTENCE",
     ["K_SINE_RULE", "K_TRIANGLE_EXISTENCE", "T_SSA_SOLVE"],
     "在△ABC中，已知 a=2，b=2√2，A=45°。求角 B，并说明解的个数。",
     "sinB = b·sinA/a = 2√2·(√2/2)/2 = 1 → B=90°，唯一解。",
     "setup_sine_rule", "正确列出正弦定理并解出 sinB", "ssa_branch_check", "讨论解的个数并验证存在性"),
    ("Q_BAS_002", "chap_01", "K_SSA", "T_SSA_BRANCH", "K_TRIANGLE_EXISTENCE",
     ["K_SSA", "K_SINE_RULE", "K_TRIANGLE_EXISTENCE", "T_SSA_BRANCH"],
     "在△ABC中，已知 a=4，b=4√2，A=30°。求角 B（注意讨论解的个数）。",
     "sinB = b·sinA/a = 4√2·(1/2)/4 = √2/2 → B=45° 或 135°，两解均满足 A+B<180°。",
     "setup_sine_rule", "正确列出正弦定理并解出 sinB", "ssa_branch_check", "检验补角分支并验证两解均合法",
     [{"dim": "K_SSA", "role": "primary", "evidence_rule": "rubric.ssa_branch_check"},
      {"dim": "T_SSA_BRANCH", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"},
      {"dim": "K_TRIANGLE_EXISTENCE", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_EXISTENCE"}]),
    ("Q_BAS_003", "chap_01", "K_SINE_RULE", "T_ANGLE_SOLVE", "K_TRIANGLE_EXISTENCE",
     ["K_SINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，A=60°，B=45°，b=2√2。求边 a。",
     "a = b·sinA/sinB = 2√2·(√3/2)/(√2/2) = 2√3。",
     "setup_sine_rule", "写出正弦定理比例式", "solve_side", "代入角度正弦并化简"),
    ("Q_BAS_004", "chap_01", "K_COSINE_RULE", "T_SIDE_SOLVE", "K_SINE_RULE",
     ["K_COSINE_RULE", "T_SIDE_SOLVE"],
     "在△ABC中，b=3，c=4，A=60°。求边 a。",
     "a² = b²+c²−2bc·cosA = 9+16−24·(1/2) = 13 → a=√13。",
     "apply_cosine", "正确代入余弦定理", "extract_root", "开方取正值并验算"),
    ("Q_BAS_005", "chap_01", "K_COSINE_RULE", "T_ANGLE_SOLVE", "K_TRIANGLE_EXISTENCE",
     ["K_COSINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，a=√7，b=2，c=√3。求角 A。",
     "cosA = (b²+c²−a²)/(2bc) = (4+3−7)/(4√3) = 0 → A=90°。",
     "apply_cosine", "写出 cosA 表达式", "solve_angle", "化简并求出角 A"),
    ("Q_BAS_006", "chap_01", "K_TRIANGLE_AREA", "T_AREA_COMPUTE", "K_COSINE_RULE",
     ["K_TRIANGLE_AREA", "T_AREA_COMPUTE"],
     "在△ABC中，b=5，c=6，A=30°。求面积 S。",
     "S = ½·b·c·sinA = ½·5·6·(1/2) = 15/2。",
     "area_formula", "写出 S=½bc·sinA", "area_compute", "代入数值计算"),
    ("Q_BAS_007", "chap_01", "K_TRIANGLE_AREA", "T_AREA_COMPUTE", "K_SINE_RULE",
     ["K_TRIANGLE_AREA", "K_SINE_RULE", "T_AREA_COMPUTE"],
     "在△ABC中，面积 S=3√3，b=2，c=6。求角 A。",
     "½·2·6·sinA = 3√3 → sinA = √3/2 → A=60° 或 120°（均使 A+B+C=180° 成立）。",
     "area_formula", "由面积公式列方程", "solve_angle", "解出 A 并讨论两解"),
    ("Q_BAS_008", "chap_01", "K_SHAPE_JUDGE", "T_SHAPE_JUDGE", "K_COSINE_RULE",
     ["K_SHAPE_JUDGE", "K_COSINE_RULE", "T_SHAPE_JUDGE"],
     "在△ABC中，若 a=2b·cosC，判断三角形形状。",
     "a = 2b·(a²+b²−c²)/(2ab) → a² = a²+b²−c² → b²=c² → b=c，等腰三角形。",
     "convert_formula", "把 cosC 用余弦定理展开", "conclude_shape", "化简并下结论"),
    ("Q_BAS_009", "chap_01", "K_SHAPE_JUDGE", "T_SHAPE_JUDGE", "K_SINE_RULE",
     ["K_SHAPE_JUDGE", "K_SINE_RULE", "T_SHAPE_JUDGE"],
     "在△ABC中，若 (a+b+c)(b+c−a)=3bc，求角 A，并判断该三角形是否一定为等边三角形。",
     "(b+c)²−a²=3bc → a²=b²+c²−bc，故 cosA=(b²+c²−a²)/(2bc)=1/2 → A=60°。条件只确定 A；例如 b=2、c=3 时 a=√7，三边不等但仍满足条件，因此不一定是等边三角形。",
     "expand_product", "展开并化简边关系", "conclude_shape", "由余弦定理得 A=60°，并用反例说明不一定等边"),
    ("Q_BAS_010", "chap_01", "K_TRIANGLE_EXISTENCE", "T_SSA_SOLVE", "K_SINE_RULE",
     ["K_TRIANGLE_EXISTENCE", "K_SINE_RULE", "T_SSA_SOLVE"],
     "在△ABC中，已知 a=√3，b=2，A=60°。求角 B 并判断解的个数。",
     "sinB = 2·(√3/2)/√3 = 1 → B=90°，唯一解。",
     "setup_sine_rule", "列出正弦定理", "count_solutions", "判断解数并说明理由",
     [{"dim": "K_TRIANGLE_EXISTENCE", "role": "primary", "evidence_rule": "rubric.count_solutions"},
      {"dim": "T_SSA_SOLVE", "role": "secondary", "evidence_rule": "rubric.setup_sine_rule"},
      {"dim": "K_SINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_SINE_RULE"}]),
    ("Q_BAS_011", "chap_01", "K_COSINE_RULE", "T_SIDE_SOLVE", "K_SINE_RULE",
     ["K_COSINE_RULE", "T_SIDE_SOLVE"],
     "在△ABC中，A=30°，b=2√3，c=3。求边 a。",
     "a² = 12+9−2·2√3·3·(√3/2) = 21−18 = 3 → a=√3。",
     "apply_cosine", "代入余弦定理", "extract_root", "化简开方"),
    ("Q_BAS_012", "chap_01", "K_COSINE_RULE", "T_SIDE_SOLVE", "K_TRIANGLE_AREA",
     ["K_COSINE_RULE", "K_TRIANGLE_AREA", "T_SIDE_SOLVE"],
     "在△ABC中，a=√3，c=1，B=30°。求边 b 与面积 S。",
     "b² = 3+1−2·√3·1·(√3/2) = 1 → b=1；S=½·√3·1·(1/2)=√3/4。",
     "apply_cosine", "余弦定理求 b", "compute_area", "面积公式求 S"),
    ("Q_BAS_013", "chap_01", "K_COSINE_RULE", "T_ANGLE_SOLVE", "K_TRIANGLE_EXISTENCE",
     ["K_COSINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，a:b:c = 3:5:7。求最大角。",
     "cosC = (9+25−49)/(2·3·5) = −15/30 = −1/2 → C=120°。",
     "apply_cosine", "对最大边对应角用余弦定理", "solve_angle", "求出最大角"),
    ("Q_BAS_014", "chap_01", "K_COSINE_RULE", "T_AREA_COMPUTE", "K_TRIANGLE_AREA",
     ["K_COSINE_RULE", "K_TRIANGLE_AREA", "T_AREA_COMPUTE"],
     "在△ABC中，A=60°，面积 S=4√3，周长 12。求三边。",
     "½bc·(√3/2)=4√3 → bc=16；a²=b²+c²−bc=(b+c)²−3bc=(12−a)²−48 → a=4，b+c=8 且 bc=16 → b=c=4。三边均为 4（等边）。",
     "area_equation", "由面积列 bc 关系", "solve_sides", "联立周长与余弦定理解边"),
    ("Q_BAS_015", "chap_01", "K_SINE_RULE", "T_ANGLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_SINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，B=75°，C=45°，a=4。求边 b。",
     "A=60°；b = a·sinB/sinA = 4·sin75°/sin60° = 4·((√6+√2)/4)/(√3/2) = 4√2。",
     "setup_sine_rule", "求 A 并列出正弦定理", "solve_side", "代入化简求 b"),
    ("Q_BAS_016", "chap_01", "K_TRIANGLE_AREA", "T_AREA_COMPUTE", "K_COSINE_RULE",
     ["K_TRIANGLE_AREA", "K_COSINE_RULE", "T_AREA_COMPUTE"],
     "在△ABC中，a=5，b=6，c=7。求面积 S。",
     "s=9，S=√(9·4·3·2)=√216=6√6。",
     "area_formula", "用海伦公式或余弦定理求面积", "area_compute", "代入计算"),
    # ── 专题二：中线、角平分线与高线（16） ──
    ("Q_SEG_001", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_COSINE_RULE",
     ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"],
     "在△ABC中，a=2，b=3，c=4。求 BC 边上的中线长 m_a。",
     "m_a = ½√(2b²+2c²−a²) = ½√(18+32−4) = ½√46。",
     "median_formula", "写出中线长公式", "compute_median", "代入计算"),
    ("Q_SEG_002", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_COSINE_RULE",
     ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"],
     "在△ABC中，AB=4，AC=6，A=60°。求 BC 边上的中线长。",
     "BC²=16+36−48·(1/2)=28；m_a²=(2·36+2·16−28)/4=19 → m_a=√19。",
     "median_formula", "先求 BC 再代中线公式", "compute_median", "计算并开方"),
    ("Q_SEG_003", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_EQUAL_AREA",
     ["K_MEDIAN", "K_EQUAL_AREA", "T_MEDIAN_SOLVE"],
     "在△ABC中，三条中线交于重心 G。若 AG=8，求中线 AD 的长。",
     "重心分中线 AG:GD=2:1 → AD = AG·3/2 = 12。",
     "centroid_ratio", "写出重心分中线比例", "compute_length", "由比例求全长"),
    ("Q_SEG_004", "chap_02", "K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE", "K_SINE_RULE",
     ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"],
     "在△ABC中，AD 平分∠A 交 BC 于 D。AB=3，AC=6，BD=2。求 DC。",
     "BD/DC = AB/AC = 3/6 = 1/2 → DC = 4。",
     "bisector_ratio", "写出角平分线比例定理", "solve_dc", "代入比例求 DC"),
    ("Q_SEG_005", "chap_02", "K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE", "K_COSINE_RULE",
     ["K_ANGLE_BISECTOR", "K_COSINE_RULE", "T_BISECTOR_SOLVE"],
     "在△ABC中，A=60°，AB=6，AC=8。AD 平分∠A 交 BC 于 D。求 AD。",
     "AD = 2bc·cos(A/2)/(b+c) = 2·6·8·(√3/2)/14 = 24√3/7。",
     "bisector_length", "写出角平分线长公式", "compute_length", "代入并化简"),
    ("Q_SEG_006", "chap_02", "K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE", "K_TRIANGLE_AREA",
     ["K_ANGLE_BISECTOR", "K_TRIANGLE_AREA", "T_BISECTOR_SOLVE"],
     "在△ABC中，A=120°，AB=4，AC=6，AD 平分∠A 交 BC 于 D。求 S_△ABD。",
     "S=½·4·6·sin120°=6√3；BD/DC=4/6=2/3 → S_△ABD = 6√3·2/5 = 12√3/5。",
     "area_split", "总面积与分边比例", "compute_part", "按比例求部分面积"),
    ("Q_SEG_007", "chap_02", "K_ALTITUDE", "T_ALTITUDE_SOLVE", "K_TRIANGLE_AREA",
     ["K_ALTITUDE", "K_TRIANGLE_AREA", "T_ALTITUDE_SOLVE"],
     "在△ABC中，AB=5，AC=7，BC=8。求 BC 边上的高 h_a。",
     "cosA=(49+64−25)/(2·7·8)=11/14 → sinA=5√3/14 → S=½·7·5·5√3/14=25√3/4 → h_a=2S/8=25√3/16。",
     "compute_area", "由两边夹一角求面积", "altitude_from_area", "h=2S/a 求高",
     [{"dim": "K_ALTITUDE", "role": "primary", "evidence_rule": "rubric.altitude_from_area"},
      {"dim": "T_ALTITUDE_SOLVE", "role": "secondary", "evidence_rule": "rubric.compute_area"},
      {"dim": "K_TRIANGLE_AREA", "role": "prerequisite", "evidence_rule": "probe.K_TRIANGLE_AREA"}]),
    ("Q_SEG_008", "chap_02", "K_ALTITUDE", "T_ALTITUDE_SOLVE", "K_TRIANGLE_AREA",
     ["K_ALTITUDE", "T_ALTITUDE_SOLVE"],
     "在△ABC中，BC=10，B=45°，C=30°。AD 为 BC 边上的高。求 AD。",
     "设 h=AD，h/tanB 与 h/tanC 分别为 BD、DC → h(1+√3)=10 → h=10/(1+√3)=5(√3−1)。",
     "split_base", "把底边按高拆成两段", "solve_height", "解方程求高"),
    ("Q_SEG_009", "chap_02", "K_ZHANG_ANGLE", "T_ALTITUDE_SOLVE", "K_SINE_RULE",
     ["K_ZHANG_ANGLE", "K_ALTITUDE", "T_ALTITUDE_SOLVE"],
     "在△ABC中，A=90°，AD⊥BC 于 D，BD=2，DC=6。求高 AD。",
     "tanB=h/2，tanC=h/6，B+C=90° → tanB·tanC=1 → h²/12=1 → h=2√3。",
     "tangent_setup", "用两角正切列式", "solve_height", "利用互余关系求 h"),
    ("Q_SEG_010", "chap_02", "K_EQUAL_AREA", "T_EQUAL_AREA", "K_TRIANGLE_AREA",
     ["K_EQUAL_AREA", "K_TRIANGLE_AREA", "T_EQUAL_AREA"],
     "在△ABC中，三边为 13，14，15。求最短边上的高。",
     "s=21，S=√(21·8·7·6)=84 → 最短边 13 → h=2S/13=168/13。",
     "compute_area", "海伦公式求面积", "shortest_height", "面积除以最短底边"),
    ("Q_SEG_011", "chap_02", "K_EQUAL_AREA", "T_EQUAL_AREA", "K_TRIANGLE_AREA",
     ["K_EQUAL_AREA", "K_TRIANGLE_AREA", "T_EQUAL_AREA"],
     "边长为 4 的等边三角形，用等面积法求高。",
     "S=½·4·4·sin60°=4√3 → h=2S/4=2√3。",
     "compute_area", "面积两种写法", "solve_height", "由 h=2S/a 求高"),
    ("Q_SEG_012", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_COSINE_RULE",
     ["K_MEDIAN", "T_MEDIAN_SOLVE"],
     "在△ABC中，b=6，c=4，BC 边上的中线 m_a=5。求 a。",
     "25=(2·36+2·16−a²)/4 → 100=104−a² → a²=4 → a=2。",
     "median_formula", "代入中线长公式", "solve_side", "解方程求 a"),
    ("Q_SEG_013", "chap_02", "K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE", "K_SINE_RULE",
     ["K_ANGLE_BISECTOR", "T_BISECTOR_SOLVE"],
     "在△ABC中，D 在 BC 上，AB=4，AC=6，BD=2，DC=3。判断 AD 是否为角平分线。",
     "BD/DC=2/3，AB/AC=4/6=2/3，比值相等 → AD 是∠A 的平分线。",
     "bisector_ratio", "计算两边比与分边比", "conclude", "由比例判定"),
    ("Q_SEG_014", "chap_02", "K_ALTITUDE", "T_ALTITUDE_SOLVE", "K_TRIANGLE_AREA",
     ["K_ALTITUDE", "K_TRIANGLE_AREA", "T_ALTITUDE_SOLVE"],
     "在△ABC中，A=45°，b=4√2，面积 S=8。求边 c。",
     "½·4√2·c·(√2/2)=8 → 2c=8 → c=4。",
     "area_equation", "由面积公式列方程", "solve_side", "解出 c"),
    ("Q_SEG_015", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_COSINE_RULE",
     ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"],
     "在△ABC中，b=4，c=6，BC 边上的中线 m_a=√13。求 a。",
     "13=(2·16+2·36−a²)/4 → 52=104−a² → a²=52 → a=2√13。",
     "median_formula", "代入中线长公式", "solve_side", "解方程求 a"),
    ("Q_SEG_016", "chap_02", "K_MEDIAN", "T_MEDIAN_SOLVE", "K_COSINE_RULE",
     ["K_MEDIAN", "K_COSINE_RULE", "T_MEDIAN_SOLVE"],
     "在△ABC中，b=8，c=5，BC 边上的中线 m_a=√21。求 a。",
     "21=(2·64+2·25−a²)/4 → 84=178−a² → a²=94 → a=√94。",
     "median_formula", "代入中线长公式", "solve_side", "解方程求 a"),
    # ── 专题三：外接圆、内切圆与多三角形（16） ──
    ("Q_CIR_001", "chap_03", "K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE", "K_SINE_RULE",
     ["K_CIRCUMCIRCLE", "K_SINE_RULE", "T_CIRCUMCIRCLE_SOLVE"],
     "在△ABC中，a=2√3，A=60°。求外接圆半径 R。",
     "R = a/(2sinA) = 2√3/(2·√3/2) = 2。",
     "circumradius_formula", "写出 R=a/(2sinA)", "compute_radius", "代入计算"),
    ("Q_CIR_002", "chap_03", "K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE", "K_TRIANGLE_EXISTENCE",
     ["K_CIRCUMCIRCLE", "K_TRIANGLE_EXISTENCE", "T_CIRCUMCIRCLE_SOLVE"],
     "在△ABC中，b=6，B=90°。求外接圆半径 R。",
     "B=90° → b 为直径 → R=3。",
     "diameter_angle", "直角所对边为直径", "compute_radius", "求半径"),
    ("Q_CIR_003", "chap_03", "K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE", "K_SINE_RULE",
     ["K_CIRCUMCIRCLE", "K_SINE_RULE", "T_CIRCUMCIRCLE_SOLVE"],
     "在△ABC中，c=2√2，C=45°。求外接圆半径 R。",
     "R = c/(2sinC) = 2√2/(2·√2/2) = 2。",
     "circumradius_formula", "写出 R=c/(2sinC)", "compute_radius", "代入计算"),
    ("Q_CIR_004", "chap_03", "K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_CIRCUMCIRCLE", "K_TRIANGLE_AREA", "T_CIRCUMCIRCLE_SOLVE"],
     "在△ABC中，A=30°，a=4。求外接圆面积。",
     "R = 4/(2·½) = 4 → S=16π。",
     "circumradius_formula", "求 R", "compute_area", "圆面积公式"),
    ("Q_CIR_005", "chap_03", "K_INCIRCLE", "T_INCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"],
     "直角△ABC 三边为 3，4，5。求内切圆半径 r。",
     "S=6，s=6 → r=S/s=1。",
     "incircle_formula", "写出 r=S/s", "compute_radius", "代入计算"),
    ("Q_CIR_006", "chap_03", "K_INCIRCLE", "T_INCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"],
     "边长为 6 的等边三角形，求内切圆半径 r。",
     "S=9√3，s=9 → r=√3。",
     "incircle_formula", "写出 r=S/s", "compute_radius", "代入计算"),
    ("Q_CIR_007", "chap_03", "K_INCIRCLE", "T_INCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"],
     "三角形面积为 12，内切圆半径 r=2。求周长。",
     "r=S/s → s=6 → 周长 2s=12。",
     "incircle_formula", "由 r=S/s 求半周长", "compute_perimeter", "求周长"),
    ("Q_CIR_008", "chap_03", "K_RADIUS_RELATION", "T_INCIRCLE_SOLVE", "K_CIRCUMCIRCLE",
     ["K_RADIUS_RELATION", "K_INCIRCLE", "K_CIRCUMCIRCLE", "T_INCIRCLE_SOLVE"],
     "等边三角形中，内切圆半径 r 与外接圆半径 R 的比值是多少？",
     "R=a/√3，r=a/(2√3) → r:R=1:2。",
     "radius_relation", "分别写出 R 与 r", "compute_ratio", "求比值"),
    ("Q_CIR_009", "chap_03", "K_MULTI_TRIANGLE", "T_MULTI_TRIANGLE", "K_TRIANGLE_AREA",
     ["K_MULTI_TRIANGLE", "K_TRIANGLE_AREA", "T_MULTI_TRIANGLE"],
     "在△ABC中，D 在 BC 上，∠BAD=30°，∠DAC=60°，AB=12，AD=8。求 AC。",
     "S_ABC=S_ABD+S_ADC：½·12·AC·sin90° = ½·12·8·sin30° + ½·8·AC·sin60° → 6AC=24+2√3·AC → AC=6+2√3。",
     "area_split", "整体面积等于两部分之和", "solve_side", "解方程求 AC"),
    ("Q_CIR_010", "chap_03", "K_COMMON_EDGE", "T_COMMON_EDGE", "K_COSINE_RULE",
     ["K_COMMON_EDGE", "K_COSINE_RULE", "T_COMMON_EDGE"],
     "△ABC 与 △DBC 共边 BC。A=60°，AB=8，AC=5，D=90° 且 BD=DC。求 BC。",
     "BC²=64+25−80·(1/2)=49 → BC=7；△DBC 为等腰直角 → BD=DC=7/√2。",
     "cosine_apply", "在△ABC 中用余弦定理求 BC", "right_triangle", "在直角△DBC 中求腰长"),
    ("Q_CIR_011", "chap_03", "K_CIRCUMCIRCLE", "T_CIRCUMCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_CIRCUMCIRCLE", "K_TRIANGLE_AREA", "T_CIRCUMCIRCLE_SOLVE"],
     "在△ABC中，A=60°，b=4，c=6。求面积与外接圆半径。",
     "S=½·4·6·sin60°=6√3；a²=16+36−48·½=28 → a=2√7 → R=a/(2sin60°)=2√21/3。",
     "compute_area", "面积公式", "circumradius_formula", "求 a 后算 R"),
    ("Q_CIR_012", "chap_03", "K_INCIRCLE", "T_INCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"],
     "直角三角形两直角边为 6，8。求内切圆半径 r。",
     "斜边 10，S=24，s=12 → r=2。",
     "incircle_formula", "写出 r=S/s", "compute_radius", "代入计算"),
    ("Q_CIR_013", "chap_03", "K_MULTI_TRIANGLE", "T_MULTI_TRIANGLE", "K_EQUAL_AREA",
     ["K_MULTI_TRIANGLE", "K_EQUAL_AREA", "T_MULTI_TRIANGLE"],
     "在△ABC中，AD 为 BC 边上的中线。比较 S_△ABD 与 S_△ADC。",
     "BD=DC 且两三角形等高 → 面积相等。",
     "area_split", "底边与高对应", "conclude", "下结论并说明理由"),
    ("Q_CIR_014", "chap_03", "K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE", "K_CIRCUMCIRCLE",
     ["K_HIDDEN_CIRCLE", "K_CIRCUMCIRCLE", "T_POWER_AND_CIRCLE"],
     "四边形 ABCD 中，∠ABC=∠ADC=90°，AB=3，BC=4。求 A、B、C、D 四点所在圆的面积。",
     "∠ABC=∠ADC=90° → 四点共圆，AC 为直径；AC=5 → S=25π/4。",
     "cyclic_detect", "由对角互补识别共圆", "compute_area", "直径求圆面积"),
    ("Q_CIR_015", "chap_03", "K_COMMON_EDGE", "T_COMMON_EDGE", "K_CIRCUMCIRCLE",
     ["K_COMMON_EDGE", "K_CIRCUMCIRCLE", "T_COMMON_EDGE"],
     "圆内接四边形 ABCD 中，BD 为直径，BD=10，∠BCD=30°。求 BC。",
     "BD 为直径 → ∠BCD 所对弧为半圆 → ∠BCD=30° → BC=BD·cos30°=5√3。",
     "diameter_angle", "直径所对圆周角为直角", "solve_side", "直角三角形求 BC"),
    ("Q_CIR_016", "chap_03", "K_INCIRCLE", "T_INCIRCLE_SOLVE", "K_TRIANGLE_AREA",
     ["K_INCIRCLE", "K_TRIANGLE_AREA", "T_INCIRCLE_SOLVE"],
     "三角形三边为 13，14，15。求内切圆半径 r。",
     "S=84，s=21 → r=4。",
     "incircle_formula", "求面积与半周长", "compute_radius", "代入计算"),
    # ── 专题四：最值与范围（16） ──
    ("Q_EXT_001", "chap_04", "K_ANGLE_TO_SIDE", "T_ANGLE_SOLVE", "K_SINE_RULE",
     ["K_ANGLE_TO_SIDE", "K_SINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，sinA:sinB:sinC = 3:4:5。求最大角。",
     "a:b:c=3:4:5 → 5²=3²+4² → 直角，最大角 90°。",
     "sine_to_side", "正弦比化为边比", "solve_angle", "由勾股逆定理定角"),
    ("Q_EXT_002", "chap_04", "K_SIDE_TO_ANGLE", "T_ANGLE_SOLVE", "K_COSINE_RULE",
     ["K_SIDE_TO_ANGLE", "K_COSINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，a²=b²+c²−√3·bc。求角 A。",
     "cosA=(b²+c²−a²)/(2bc)=√3/2 → A=30°。",
     "cosine_apply", "由条件求 cosA", "solve_angle", "求出角 A"),
    ("Q_EXT_003", "chap_04", "K_INEQUALITY", "T_INEQUALITY_APPLY", "K_COSINE_RULE",
     ["K_INEQUALITY", "K_COSINE_RULE", "T_INEQUALITY_APPLY"],
     "在△ABC中，a+b=8，C=60°。求边 c 的最小值。",
     "c²=a²+b²−ab=(a+b)²−3ab ≥ 64−3·16=16 → c≥4，a=b=4 时取等 → c_min=4。",
     "cosine_expand", "用余弦定理展开 c²", "inequality_apply", "基本不等式求下界并验证取等"),
    ("Q_EXT_004", "chap_04", "K_INEQUALITY", "T_INEQUALITY_APPLY", "K_TRIANGLE_AREA",
     ["K_INEQUALITY", "K_TRIANGLE_AREA", "T_INEQUALITY_APPLY"],
     "在△ABC中，a+b=10，C=60°。求面积 S 的最大值。",
     "S=½ab·sin60°=√3ab/4 ≤ √3/4·25 = 25√3/4，a=b=5 取等。",
     "area_expression", "面积用 ab 表达", "inequality_apply", "ab 上界并验证取等"),
    ("Q_EXT_005", "chap_04", "K_TRIG_RANGE", "T_TRIG_FUNC_RANGE", "K_SINE_RULE",
     ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"],
     "在△ABC中，a=2，A=60°。求周长 p 的取值范围。",
     "b+c=(4/√3)(sinB+sinC)=4cos((B−C)/2) ∈ (2,4] → p ∈ (4,6]。",
     "sine_express", "边化角表达周长", "trig_range", "和差化积求范围"),
    ("Q_EXT_006", "chap_04", "K_EDGE_RANGE", "T_TRIG_FUNC_RANGE", "K_SINE_RULE",
     ["K_EDGE_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"],
     "在△ABC中，c=2，C=60°。求 a+b 的取值范围。",
     "a+b=(2/sin60°)(sinA+sinB)=4cos((A−B)/2) ∈ (2,4]。",
     "sine_express", "边化角表达 a+b", "trig_range", "求范围并说明开闭"),
    ("Q_EXT_007", "chap_04", "K_TRIG_RANGE", "T_TRIG_FUNC_RANGE", "K_SINE_RULE",
     ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"],
     "在△ABC中，A=60°。求 2sinB+2sinC 的最大值。",
     "B+C=120° → sinB+sinC=√3·cos((B−C)/2) ≤ √3 → 最大值 2√3（B=C=60°）。",
     "sum_to_product", "和差化积", "trig_range", "由 cos≤1 求最大值"),
    ("Q_EXT_008", "chap_04", "K_EDGE_RANGE", "T_INEQUALITY_APPLY", "K_COSINE_RULE",
     ["K_EDGE_RANGE", "K_COSINE_RULE", "T_INEQUALITY_APPLY"],
     "在△ABC中，a²+b²−ab=c²。求 (a+b)/c 的最大值。",
     "令 t=a/b：((a+b)/c)²=(t²+2t+1)/(t²−t+1) ≤ 4（t=1 时取等）→ 最大值 2（等边）。",
     "ratio_square", "把比值平方并换元", "inequality_apply", "求上界并验证取等"),
    ("Q_EXT_009", "chap_04", "K_INEQUALITY", "T_MAX_MIN", "K_COSINE_RULE",
     ["K_INEQUALITY", "K_COSINE_RULE", "T_MAX_MIN"],
     "在△ABC中，a+b+c=6，C=60°。求面积 S 的最大值。",
     "S=√3ab/4；c²=a²+b²−ab ≥ (a+b)²/4 → c≥2，a=b=2 时取等 → S_max=√3。",
     "area_expression", "面积用 ab 表达", "inequality_apply", "由余弦与不等式求上界",
     [{"dim": "K_INEQUALITY", "role": "primary", "evidence_rule": "rubric.inequality_apply"},
      {"dim": "T_MAX_MIN", "role": "secondary", "evidence_rule": "rubric.area_expression"},
      {"dim": "K_COSINE_RULE", "role": "prerequisite", "evidence_rule": "probe.K_COSINE_RULE"}]),
    ("Q_EXT_010", "chap_04", "K_EDGE_RANGE", "T_TRIG_FUNC_RANGE", "K_SINE_RULE",
     ["K_EDGE_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"],
     "在△ABC中，b=2，B=60°。求 a+c 的取值范围。",
     "a+c=(2/sin60°)(sinA+sinC)=4cos((A−C)/2) ∈ (2,4]。",
     "sine_express", "边化角表达 a+c", "trig_range", "求范围并说明开闭"),
    ("Q_EXT_011", "chap_04", "K_SIDE_TO_ANGLE", "T_ANGLE_SOLVE", "K_COSINE_RULE",
     ["K_SIDE_TO_ANGLE", "K_COSINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，a·cosC + c·cosA = 3。求边 b。",
     "a·cosC+c·cosA = b（投影定理）→ b=3。",
     "projection_apply", "识别投影定理", "solve_side", "由恒等式求 b"),
    ("Q_EXT_012", "chap_04", "K_EDGE_RANGE", "T_MAX_MIN", "K_COSINE_RULE",
     ["K_EDGE_RANGE", "K_COSINE_RULE", "T_MAX_MIN"],
     "在△ABC中，a+b=8，C=120°。求边 c 的取值范围。",
     "c²=(a+b)²−ab=64−ab ∈ (0,48] → 4√3 ≤ c < 8（a=b=4 时 c=4√3，ab→0 时 c→8）。",
     "cosine_expand", "余弦定理展开 c²", "range_solve", "由 ab 范围求 c 范围"),
    ("Q_EXT_013", "chap_04", "K_TRIANGLE_EXISTENCE", "T_ANGLE_SOLVE", "K_TRIG_RANGE",
     ["K_TRIANGLE_EXISTENCE", "K_TRIG_RANGE", "T_ANGLE_SOLVE"],
     "在△ABC中，A=30°。求角 B 的取值范围使三角形存在。",
     "C=150°−B>0 且 B>0 → B ∈ (0°,150°)。",
     "existence_setup", "由内角和列约束", "range_solve", "写出 B 的范围"),
    ("Q_EXT_014", "chap_04", "K_TRIANGLE_AREA", "T_MAX_MIN", "K_INEQUALITY",
     ["K_TRIANGLE_AREA", "K_INEQUALITY", "T_MAX_MIN"],
     "在△ABC中，a=2，A=60°。求面积 S 的最大值。",
     "b+c ≤ 4（Q_EXT_010 同构），S=½bc·sin60° ≤ ½·4·(√3/2)=√3，b=c=2 取等。",
     "area_expression", "面积用 bc 表达", "inequality_apply", "bc 上界并验证取等"),
    ("Q_EXT_015", "chap_04", "K_SIDE_TO_ANGLE", "T_SHAPE_JUDGE", "K_SINE_RULE",
     ["K_SIDE_TO_ANGLE", "K_SINE_RULE", "T_SHAPE_JUDGE"],
     "在△ABC中，sin²A+sin²B=sin²C。求角 C。",
     "边化角：a²+b²=c² → C=90°。",
     "sine_to_side", "正弦比化为边比", "solve_angle", "勾股逆定理定角"),
    ("Q_EXT_016", "chap_04", "K_TRIG_RANGE", "T_TRIG_FUNC_RANGE", "K_SINE_RULE",
     ["K_TRIG_RANGE", "K_SINE_RULE", "T_TRIG_FUNC_RANGE"],
     "在△ABC中，B+C=120°。求 sinB+sinC 的最大值。",
     "sinB+sinC=2sin60°·cos((B−C)/2)=√3·cos((B−C)/2) ≤ √3，B=C=60° 取等。",
     "sum_to_product", "和差化积", "trig_range", "求最大值并给出取等条件"),
    # ── 专题五：定理与模型（16） ──
    ("Q_THE_001", "chap_05", "K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY", "K_SINE_RULE",
     ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"],
     "在△ABC中，A=45°，B=60°。求角 C。",
     "tanC = −tan(A+B) = −(1+√3)/(1−√3) = 2+√3 → C=75°。",
     "tangent_identity", "正切和角公式求 tanC", "solve_angle", "反解角 C"),
    ("Q_THE_002", "chap_05", "K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY", "K_TRIANGLE_EXISTENCE",
     ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"],
     "在△ABC中，tanA=2，tanB=3。求角 C。",
     "tanC = −(tanA+tanB)/(1−tanA·tanB) = −5/(1−6) = 1 → C=45°。",
     "tangent_identity", "正切和角公式", "solve_angle", "求 C"),
    ("Q_THE_003", "chap_05", "K_SINE_SQUARE_DIFF", "T_ANGLE_SOLVE", "K_SINE_RULE",
     ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_ANGLE_SOLVE"],
     "在△ABC中，A=60°，B=45°。求 sin²A−sin²B 的值。",
     "sin²A−sin²B = sin(A+B)·sin(A−B) = sin105°·sin15° = ((√6+√2)/4)·((√6−√2)/4) = 1/4。",
     "square_diff", "正弦平方差公式", "compute_value", "代入求值"),
    ("Q_THE_004", "chap_05", "K_SINE_SQUARE_DIFF", "T_SHAPE_JUDGE", "K_SINE_RULE",
     ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_SHAPE_JUDGE"],
     "在△ABC中，sin²A−sin²B=sin²C。判断三角形形状。",
     "sin(A+B)·sin(A−B)=sin²C → sinC·sin(A−B)=sin²C → sin(A−B)=sinC → A−B=C 或 A−B=180°−C；前者 A=90°（直角），后者 A=90°+... 由 B+C<180° 排除 → A=90°。",
     "square_diff", "正弦平方差展开", "conclude_shape", "化简并判断形状"),
    ("Q_THE_005", "chap_05", "K_POWER_OF_POINT", "T_POWER_AND_CIRCLE", "K_COSINE_RULE",
     ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"],
     "圆内两弦 AB、CD 交于 P，PA=3，PB=6，PC=2。求 PD。",
     "相交弦定理：PA·PB=PC·PD → PD = 3·6/2 = 9。",
     "power_theorem", "写出相交弦定理", "solve_length", "代入求 PD"),
    ("Q_THE_006", "chap_05", "K_POWER_OF_POINT", "T_POWER_AND_CIRCLE", "K_COSINE_RULE",
     ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"],
     "从圆外一点 P 引切线 PT 与割线 PAB，PA=4，PB=9。求切线长 PT。",
     "切割线定理：PT²=PA·PB=36 → PT=6。",
     "power_theorem", "写出切割线定理", "solve_length", "求 PT"),
    ("Q_THE_007", "chap_05", "K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE", "K_TRIANGLE_EXISTENCE",
     ["K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE"],
     "定点 A、B 满足 AB=8，动点 P 满足 ∠APB=90°。求点 P 轨迹圆的面积。",
     "∠APB=90° → P 在以 AB 为直径的圆上 → 半径 4 → S=16π。",
     "cyclic_detect", "直角圆周角定直径", "compute_area", "求圆面积"),
    ("Q_THE_008", "chap_05", "K_HIDDEN_CIRCLE", "T_POWER_AND_CIRCLE", "K_CIRCUMCIRCLE",
     ["K_HIDDEN_CIRCLE", "K_CIRCUMCIRCLE", "T_POWER_AND_CIRCLE"],
     "定点 A、B 满足 AB=2√3，动点 P 满足 ∠APB=60°。求 P 所在圆弧所在圆的半径。",
     "P 在以 AB 为弦、圆周角 60° 的圆弧上 → 2R·sin60°=AB → R=2√3/√3=2。",
     "cyclic_detect", "定角圆周角定圆弧", "compute_radius", "由正弦求半径"),
    ("Q_THE_009", "chap_05", "K_APOLLONIUS", "T_POWER_AND_CIRCLE", "K_COSINE_RULE",
     ["K_APOLLONIUS", "T_POWER_AND_CIRCLE"],
     "定点 A(0,0)、B(6,0)，动点 P 满足 PA:PB=2:1。求 P 轨迹圆的半径。",
     "(x²+y²)=4((x−6)²+y²) → x²+y²−16x+48=0 → (x−8)²+y²=16 → 半径 4。",
     "apollonius_setup", "按比例平方列方程", "complete_square", "配方求半径"),
    ("Q_THE_010", "chap_05", "K_POWER_OF_POINT", "T_POWER_AND_CIRCLE", "K_INCIRCLE",
     ["K_POWER_OF_POINT", "K_INCIRCLE", "T_POWER_AND_CIRCLE"],
     "三角形三边为 13，14，15，其内切圆与 AB（c=15 对边）切于点 D。求从顶点 A 到切点 D 的切线长。",
     "切线长 = s−a = 21−13 = 8。",
     "tangent_length", "切线长等于半周长减对边", "solve_length", "代入计算"),
    ("Q_THE_011", "chap_05", "K_PTOLEMY", "T_PTOLEMY", "K_POWER_OF_POINT",
     ["K_PTOLEMY", "K_POWER_OF_POINT", "T_PTOLEMY"],
     "圆内接四边形 ABCD 中，AB=3，BC=4，CD=5，DA=6。求 AC·BD。",
     "托勒密：AC·BD = AB·CD + BC·DA = 15+24 = 39。",
     "ptolemy_apply", "写出托勒密定理", "compute_product", "代入求对角线乘积"),
    ("Q_THE_012", "chap_05", "K_PTOLEMY", "T_PTOLEMY", "K_COSINE_RULE",
     ["K_PTOLEMY", "K_COSINE_RULE", "T_PTOLEMY"],
     "圆内接矩形长 4、宽 3。求两条对角线长度的乘积。",
     "对角线均为 5 → 乘积 25（托勒密：AC·BD=AB·CD+BC·DA=3·3+4·4=25 ✓）。",
     "ptolemy_apply", "用托勒密定理", "compute_product", "求对角线乘积"),
    ("Q_THE_013", "chap_05", "K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY", "K_SINE_RULE",
     ["K_TANGENT_IDENTITY", "T_TANGENT_IDENTITY"],
     "在△ABC中，tanA=1，tanB=3。求 tanC。",
     "tanC = −(1+3)/(1−3) = 2。",
     "tangent_identity", "正切和角公式", "solve_angle", "求 tanC"),
    ("Q_THE_014", "chap_05", "K_SINE_SQUARE_DIFF", "T_SHAPE_JUDGE", "K_SINE_RULE",
     ["K_SINE_SQUARE_DIFF", "K_SINE_RULE", "T_SHAPE_JUDGE"],
     "在△ABC中，sin²A=sin²B+sin²C。判断三角形形状。",
     "边化角：a²=b²+c² → A=90°，直角三角形。",
     "sine_to_side", "正弦比化为边比", "conclude_shape", "勾股逆定理判断"),
    ("Q_THE_015", "chap_05", "K_POWER_OF_POINT", "T_POWER_AND_CIRCLE", "K_COSINE_RULE",
     ["K_POWER_OF_POINT", "T_POWER_AND_CIRCLE"],
     "从圆外一点 A 作切线 AT 切圆于 T，AT=4；过 A 的割线交圆于 B、C（B 在 A、C 之间），AB=2。求 AC。",
     "切割线定理：AT²=AB·AC → 16=2·AC → AC=8。",
     "power_theorem", "切割线定理", "solve_length", "求 AC"),
    ("Q_THE_016", "chap_05", "K_PTOLEMY", "T_PTOLEMY", "K_COSINE_RULE",
     ["K_PTOLEMY", "K_COSINE_RULE", "T_PTOLEMY"],
     "等腰梯形 ABCD 中，AB∥CD，AB=2，CD=6，腰 AD=BC=4，且四点共圆。求对角线 AC。",
     "托勒密：AC·BD=AB·CD+BC·AD=12+16=28；等腰梯形对角线相等 → AC=2√7。",
     "ptolemy_apply", "托勒密定理求对角线乘积", "solve_length", "由对角线相等求 AC"),
]


def q_json(q) -> dict:
    qid, chapter, k_main, t_type, k_pre, tags, stem, answer, r1, r1d, r2, r2d = q[:12]
    targets_override = q[12] if len(q) > 12 else None
    return {
        "question_id": qid, "tenant_id": TENANT, "chapter_id": chapter, "question_version": 1,
        "stem_markdown": stem, "stem_format": "open_solution",
        "answer": {"summary": answer},
        "rubric": {"items": [
            {"id": r1, "description": r1d, "score_weight": 0.5, "evidence_rule": r1},
            {"id": r2, "description": r2d, "score_weight": 0.5, "evidence_rule": r2},
        ]},
        "tags": tags,
        "measurement_targets": targets_override if targets_override else [
            {"dim": k_main, "role": "primary", "evidence_rule": f"rubric.{r1}"},
            {"dim": t_type, "role": "secondary", "evidence_rule": f"rubric.{r2}"},
            {"dim": k_pre, "role": "prerequisite", "evidence_rule": f"probe.{k_pre}"},
        ],
    }


def package_contents(chapter: str) -> dict:
    qs = [q for q in QUESTIONS if q[1] == chapter]
    qids = [q[0] for q in qs]
    dims = sorted({mt["dim"] for q in qs for mt in q_json(q)["measurement_targets"]})
    k_ids = [d for d in dims if d.startswith("K_")]
    t_ids = [d for d in dims if d.startswith("T_")]
    rule_ids = [r[0] for r in DIAGNOSIS_RULES if any(d in dims for d in r[4])]
    e_ids = sorted({e for r in DIAGNOSIS_RULES if r[0] in rule_ids for e in r[2]})
    return {"knowledge_components": k_ids, "question_types": t_ids, "error_causes": e_ids,
            "questions": qids, "diagnosis_rules": rule_ids}


# ─────────────────────────── 输出工具 ───────────────────────────

def J(obj) -> str:
    """JSON 序列化（供 JQ/JA 使用）。"""
    return json.dumps(obj, ensure_ascii=False)


def JQ(obj) -> str:
    """SQL jsonb 字面量：'{...}'（单引号转义）。"""
    return "'" + J(obj).replace("'", "''") + "'"


def JA(obj) -> str:
    """SQL text[] 字面量：'{"a","b"}'（元素为简单 token）。"""
    return "'{" + ",".join(json.dumps(str(x), ensure_ascii=False) for x in obj) + "}'"


OUT: list[str] = []


def line(s: str = "") -> None:
    OUT.append(s)


# ─────────────────────────── 三个完整学生案例（黄金演示数据，§17.2） ───────────────────────────

def build_case(student_id: str, profile: dict, sessions: list, decision_spec: dict,
                plan_explanation: str, plan_mastery: dict) -> None:
    """输出一个学生全链黄金数据。所有数值（BKT 基线/p_final/state/观测数）由生成器
    按与 learning/validator 相同的公式计算，保证演示数据自洽（P0-8 状态一致性）。"""
    # 画像
    line(f"insert into state_student_profile (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)")
    line(f"values ('{student_id}', '{TENANT}', '{profile['grade']}', {profile['current_score']}, {profile['target_score']}, "
         f"'{profile['weekly_hours']}', {JA(profile['self_weak'])}, '{profile['device_draft']}', {JQ({**profile, 'student_id': student_id, 'tenant_id': TENANT, 'updated_at': NOW})})")
    line(f"on conflict (student_id) do update set grade = excluded.grade, current_score = excluded.current_score, "
         f"target_score = excluded.target_score, weekly_hours = excluded.weekly_hours, self_weak = excluded.self_weak, "
         f"device_draft = excluded.device_draft, payload = excluded.payload, updated_at = now();")

    per_dim_outcomes: dict[str, list[str]] = {}

    for s in sessions:
        sid, question_id = s["session_id"], s["question_id"]
        q = next(x for x in QUESTIONS if x[0] == question_id)
        targets = {mt["evidence_rule"]: mt["dim"] for mt in q_json(q)["measurement_targets"]}
        primary_dim = q_json(q)["measurement_targets"][0]["dim"]
        attempts = s["attempts"]

        # 会话
        line(f"insert into runtime_question_session (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version, mode, draft_enabled, state, state_history, hint_level, probe_rounds, termination_reason, payload)")
        line(f"values ('{sid}', '{TENANT}', '{student_id}', null, '{question_id}', '1.0.0', 'diagnostic', false, 'CLOSED', "
             f"jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','SUBMIT','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','GRADE','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','SCIENTIFIC_EVALUATE','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','TEACHING_SESSION_SUMMARY','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','CLOSE','entered_at',now(),'actor','orchestrator'),"
             f"jsonb_build_object('state','QUEUE_DREAM','entered_at',now(),'actor','orchestrator')), 0, {len(attempts)}, null, "
             f"{JQ({'session_id': sid, 'tenant_id': TENANT, 'student_id': student_id, 'question_id': question_id, 'chapter_package_version': '1.0.0', 'mode': 'diagnostic', 'draft_enabled': False, 'counts_toward_independent_evidence': True, 'state': 'CLOSED', 'closed_at': NOW})})")
        line("on conflict (session_id) do nothing;")

        claim_id, claim_status = None, None
        obs_ids: list[str] = []
        obs_rows = []  # (dim, outcome, independent, evidence_rule, judgment_ref, evidence_refs)
        for at in attempts:
            aid, jid, verdict, items, summary = at["attempt_id"], at["judgment_id"], at["verdict"], at["rubric_items"], at["decision_summary"]
            kind = at.get("kind", "answer")
            line(f"insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)")
            line(f"values ('{aid}', '{TENANT}', '{sid}', '{student_id}', {JQ({'answer_text': at['answer_text'], 'kind': kind, 'submitted_at': NOW})}) on conflict (attempt_id) do nothing;")
            line(f"insert into runtime_answer_verdict (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)")
            line(f"values ('{jid}', '{TENANT}', '{sid}', '{aid}', '{verdict}', 'low', 'demo.model', 'teach-grade@0.4.0', "
                 f"{JQ({'judgment_id': jid, 'session_id': sid, 'attempt_id': aid, 'verdict': verdict, 'rubric_items': [{'id': i['id'], 'status': i['status'], 'evidence_refs': [f'{kind}://{sid}/{aid}']} for i in items], 'decision_summary': summary, 'uncertainty': 'low', 'injection_flags': [], 'kind': kind, 'model_id': 'demo.model', 'prompt_version': 'teach-grade@0.4.0', 'created_at': NOW})}) on conflict (judgment_id) do nothing;")

            # 观测（P0-6：主答按评分点写题卡对应维度；probe teaching_only 不独立）
            for item in items:
                if item["status"] == "unclear":
                    continue
                if item["id"] == "probe.judge":
                    continue  # 探针判定单独成观测（kind=probe 分支），避免重复计数
                outcome = "success" if item["status"] == "met" else "failure"
                independent = kind == "answer"
                rule = f"rubric.{item['id']}"
                dim = targets.get(rule, primary_dim)
                obs_rows.append((dim, outcome, independent, rule, jid, [f"{kind}://{sid}/{aid}"]))
            if kind == "probe":
                outcome = "success" if verdict == "correct" else "failure"
                obs_rows.append((primary_dim, outcome, False, "probe.judge", jid, [f"probe://{sid}/{aid}"]))

            if at.get("claim"):
                claim_id = at["claim"]["claim_id"]
                claim_status = at["claim"]["status"]
                card_id = at["claim"].get("card_id")
                line(f"insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)")
                line(f"values ('{claim_id}', '{TENANT}', '{sid}', '{claim_status}', "
                     f"{JQ({'claim_id': claim_id, 'session_id': sid, 'status': claim_status, 'candidates': at['claim']['candidates'], 'probe': at['claim'].get('probe'), 'card': {'artifact_id': f'art_{claim_id}', 'card_id': card_id} if card_id else None, 'resolved': at['claim'].get('resolved', False), 'rationale': at['claim'].get('rationale', ''), 'probe_history': at['claim'].get('probe_history', []), 'created_at': NOW})}) on conflict (claim_id) do nothing;")
                if card_id:
                    line(f"insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)")
                    line(f"values ('art_{claim_id}', '{TENANT}', '{sid}', 'question_card', 'native_card', 'artifact://{sid}/art_{claim_id}') on conflict (artifact_id) do nothing;")

        # 观测落库（含 judgment_id + evidence_refs）
        for dim, outcome, independent, evidence_rule, jid, refs in obs_rows:
            oid = f"obs_{sid}_{len(obs_ids) + 1}"
            obs_ids.append(oid)
            line(f"insert into runtime_state_observation (observation_id, tenant_id, student_id, dimension_id, question_id, session_id, judgment_id, outcome, independent, evidence_rule, hint_level, payload)")
            line(f"values ('{oid}', '{TENANT}', '{student_id}', '{dim}', '{question_id}', '{sid}', '{jid}', '{outcome}', {str(independent).lower()}, '{evidence_rule}', 0, "
                 f"{JQ({'observation_id': oid, 'tenant_id': TENANT, 'student_id': student_id, 'dimension_id': dim, 'question_id': question_id, 'session_id': sid, 'outcome': outcome, 'independent': independent, 'evidence_rule': evidence_rule, 'hint_level': 0, 'evidence_refs': refs, 'model_version': 'pi.scnet', 'rule_version': evidence_rule, 'supersedes': None, 'created_at': NOW})}) on conflict (observation_id) do nothing;")
            if independent and outcome in ("success", "failure"):
                per_dim_outcomes.setdefault(dim, []).append(outcome)

        # SER（baseline = 历史独立观测重放，与 learning 的 Math.round 一致）
        ser_id = s["ser_id"]
        p_base = bkt_replay(per_dim_outcomes.get(primary_dim, []))
        ser_payload = {"report_id": ser_id, "session_id": sid, "student_id": student_id, "dimension_id": primary_dim,
                       "p_bkt_baseline": p_base, "independent_observation_count": len(per_dim_outcomes.get(primary_dim, [])),
                       "parameter_set_id": "bkt_prior_v1", "calibration_status": "prior_only",
                       "input_event_refs": obs_ids, "calculation_trace_ref": f"calc_{sid}", "kernel_version": "mastery-bkt@0.1.0", "created_at": NOW}
        line(f"insert into state_scientific_evaluation_report (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline, calibration_status, parameter_set_id, kernel_version, payload)")
        line(f"values ('{ser_id}', '{TENANT}', '{sid}', '{student_id}', '{primary_dim}', {p_base}, 'prior_only', 'bkt_prior_v1', 'mastery-bkt@0.1.0', {JQ(ser_payload)}) on conflict (report_id) do nothing;")

        # TSS
        tss_id = s["tss_id"]
        tss_payload = {"summary_id": tss_id, "session_id": sid, "scientific_evaluation_ref": ser_id,
                       "summary": s["summary"], "method_observations": [],
                       "misconception_candidates": [{"claim_id": claim_id, "status": claim_status}] if claim_id else [],
                       "hint_dependency": "low", "unresolved": [{"claim_id": claim_id}] if claim_status == "unresolved" else [],
                       "evidence_refs": [f"answer://{sid}/{a['attempt_id']}" for a in attempts if a.get('kind', 'answer') == 'answer'],
                       "model_id": "demo.model", "prompt_version": "teach-summary@0.3.0", "created_at": NOW}
        line(f"insert into runtime_teaching_session_summary (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)")
        line(f"values ('{tss_id}', '{TENANT}', '{sid}', '{ser_id}', 'demo.model', 'teach-summary@0.3.0', {JQ(tss_payload)}) on conflict (summary_id) do nothing;")

        # SLR
        slr_id = s["slr_id"]
        line(f"insert into runtime_session_learning_record (record_id, tenant_id, session_id, student_id, ser_id, tss_id, integrity_passed, dream_consumed_at, payload)")
        line(f"values ('{slr_id}', '{TENANT}', '{sid}', '{student_id}', '{ser_id}', '{tss_id}', true, now(), "
             f"{JQ({'record_id': slr_id, 'session_id': sid, 'student_id': student_id, 'scientific_evaluation_report_id': ser_id, 'teaching_session_summary_id': tss_id, 'integrity_check': {'session_id_match': True, 'cross_refs_present': True, 'provenance_complete': True, 'passed': True}, 'dream_queued_at': NOW, 'created_at': NOW})}) on conflict (record_id) do nothing;")

    # ── Dream PUD + 快照（数值全部由公式计算，保证 validator 0.2.0 自洽） ──
    ids = decision_spec["_ids"]
    did, vid, snap_id = ids["decision_id"], ids["validation_id"], ids["snapshot_id"]
    dim_updates, snapshot_dims = [], []
    for dim, spec in decision_spec.items():
        if dim == "_ids" or not isinstance(spec, dict) or "ledger" not in spec:
            continue
        outcomes = per_dim_outcomes.get(dim, [])
        base = bkt_replay(outcomes)
        count = len(outcomes)
        sum_log_lr = sum(_math.log(e["lr_used"]) for e in spec["ledger"])
        p_final = round(1 / (1 + _math.exp(-(logit(base) + sum_log_lr))) * 1000) / 1000
        state = mastery_state(p_final, count)
        dim_updates.append({"dimension_id": dim, "p_baseline": base, "p_final": p_final, "state_final": state,
                            "uncertainty": spec.get("uncertainty", "medium"),
                            "evidence_ledger": [dict(e) for e in spec["ledger"]]})
        snapshot_dims.append({"dimension_id": dim, "p_profile": p_final, "p_bkt_baseline": base, "state": state,
                              "uncertainty": spec.get("uncertainty", "medium"), "independent_observation_count": count})

    ser_refs = [s["ser_id"] for s in sessions]
    tss_refs = [s["tss_id"] for s in sessions]
    pud = {"decision_id": did, "student_id": student_id, "prior_snapshot_id": None,
           "baseline_report_refs": ser_refs, "teaching_summary_refs": tss_refs,
           "dimension_updates": dim_updates, "semantic_profile_updates": [],
           "review_required": False, "model_id": "demo.model", "prompt_version": "dream-profile@0.5.0",
           "skill_version": "profile-skill@0.3.0", "created_at": NOW}
    line(f"insert into state_profile_update_decision (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes, review_required, model_id, prompt_version, skill_version, payload)")
    line(f"values ('{did}', '{TENANT}', '{student_id}', null, null, null, false, 'demo.model', 'dream-profile@0.5.0', 'profile-skill@0.3.0', {JQ(pud)}) on conflict (decision_id) do nothing;")
    line(f"insert into state_profile_decision_validation (validation_id, tenant_id, decision_id, result, validator_version, payload)")
    line(f"values ('{vid}', '{TENANT}', '{did}', 'passed', 'profile-validator-0.2.0', {JQ({'validation_id': vid, 'decision_id': did, 'result': 'passed', 'validator_version': 'profile-validator-0.2.0', 'validated_at': NOW})}) on conflict (validation_id) do nothing;")
    misconceptions = decision_spec.get("misconceptions", [])
    snap_payload = {"snapshot_id": snap_id, "student_id": student_id, "source_decision_id": did, "supersedes": None,
                    "dimensions": snapshot_dims, "misconceptions": misconceptions, "semantic_profile": {}, "profile_lag": False}
    line(f"insert into state_student_snapshot (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)")
    line(f"values ('{snap_id}', '{TENANT}', '{student_id}', '{did}', null, false, {JQ(snap_payload)}) on conflict (snapshot_id) do nothing;")
    for d in snapshot_dims:
        line(f"insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)")
        line(f"values ('{TENANT}', '{student_id}', '{d['dimension_id']}', {d['p_profile']}, '{d['state']}', '{did}')")
        line(f"on conflict (student_id, dimension_id) do update set p_profile = excluded.p_profile, state = excluded.state, source_decision_id = excluded.source_decision_id, updated_at = now();")
    for m in misconceptions:
        line(f"insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs)")
        line(f"values ('{TENANT}', '{student_id}', '{m['error_cause_id']}', '{m['state']}', {JQ(m.get('evidence_refs', []))}) on conflict (student_id, error_cause_id) do nothing;")
    line(f"insert into state_retention_state (tenant_id, student_id, dimension_id, i90_posterior, next_review_due, stable, updated_at)")
    line(f"values ('{TENANT}', '{student_id}', '{snapshot_dims[0]['dimension_id']}', {JQ({'0.5': 0.125, '1': 0.125, '2': 0.125, '4': 0.125, '8': 0.125, '16': 0.125, '32': 0.125, '64': 0.125})}, null, false, now()) on conflict (student_id, dimension_id) do nothing;")

    # 计划（planner.ts 同构）
    plan_id = f"pln_{student_id}"
    tasks = plan_tasks(profile, plan_mastery)
    plan_payload = {"plan_id": plan_id, "student_id": student_id, "tenant_id": TENANT, "horizon_weeks": 4,
                    "explanation": plan_explanation, "tasks": tasks, "plan_skipped": None, "created_at": NOW}
    line(f"insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)")
    line(f"values ('{plan_id}', '{TENANT}', '{student_id}', 4, {JQ(plan_payload)}) on conflict (plan_id) do update set student_id = excluded.student_id, horizon_weeks = excluded.horizon_weeks, payload = excluded.payload;")

def plan_tasks(profile: dict, mastery: dict, horizon: int = 4) -> list:
    """planner.ts 同构：每周预算原子数 = weekly_minutes/30，任务只在 1..horizon 落位。"""
    minutes = {"1-3": 120, "4-6": 240, "7-10": 420, "10+": 600}[profile["weekly_hours"]]
    budget = max(1, minutes // 30)
    weak = [d for d, m in mastery.items() if m["state"] in ("weak", "learning")] + [d for d in profile["self_weak"] if d not in mastery or mastery[d]["state"] not in ("weak", "learning")]
    weak = list(dict.fromkeys(weak))
    insufficient = [d for d, m in mastery.items() if m["state"] == "insufficient_evidence"]
    demands = []
    for dim in weak:
        demands.append((1, "knowledge_review", [dim], "能独立复述该维度核心方法与适用条件", "下周低档练习正确率 ≥0.7"))
        demands.append((1, "practice_easy", [dim], "低一档练习正确率 ≥0.7", "达标后进入原难度练习"))
        demands.append((2, "practice_normal", [dim], "原难度练习正确率 ≥0.7 且无提示", "独立复测到期后验证"))
    for dim in insufficient:
        demands.append((1, "practice_easy", [dim], "覆盖练习 ≥3 题且正确率 ≥0.7", "后续会话纳入覆盖测评"))
    gap = (profile.get("target_score") or 0) - (profile.get("current_score") or 0)
    if gap >= 20:
        for dim in weak + insufficient:
            demands.append((3, "practice_normal", [dim], "原难度综合题正确率 ≥0.7", "周 4 迁移题验证"))
            demands.append((4, "transfer", [dim], "跨表征/题型独立迁移成功", "迁移成功进入画像证据账本"))
    load: dict[int, int] = {}
    tasks = []
    for week, kind, dims, criterion, cond in demands:
        for w in range(week, horizon + 1):
            if load.get(w, 0) < budget:
                load[w] = load.get(w, 0) + 1
                tasks.append({"week": w, "kind": kind, "dimension_ids": dims, "criterion": criterion, "review_condition": cond, "minutes": 30})
                break
        else:
            break
    return tasks


# ─────────────────────────── 生成 seed.sql ───────────────────────────

def emit() -> None:
    line("-- 仅供测试的合成 fixtures（由 deploy/dev/seed_gen.py 生成），不是比赛内容入库路径。")
    line("-- 默认 compose 不加载本文件；正式数据库只能由教师资料批次经 OCR -> KTQ -> ER -> 复核 -> 发布生成。")
    line("-- 生成：python3 deploy/dev/seed_gen.py > deploy/dev/seed.sql")
    line("begin;")
    line("")
    line("do $$")
    line("begin")
    line("  if not exists (select from pg_roles where rolname = 'mathpilot_app') then")
    line("    create role mathpilot_app login password 'mathpilot-app-dev-only';")
    line("  end if;")
    line("end $$;")
    line("grant usage on schema public to mathpilot_app;")
    line("grant select, insert, update, delete on all tables in schema public to mathpilot_app;")
    line("")
    line("insert into identity_tenant(tenant_id, name)")
    line(f"values ('{TENANT}', 'Dev Tenant') on conflict (tenant_id) do nothing;")
    line("")
    line("insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)")
    line("values")
    line("  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher,content_reviewer}'),")
    line("  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student 01', '{student}'),")
    line("  ('usr_student02', 'tnt_dev00001', 'sub-student-02', 'Dev Student 02', '{student}'),")
    line("  ('usr_student03', 'tnt_dev00001', 'sub-student-03', 'Dev Student 03', '{student}')")
    line("on conflict (user_id) do nothing;")
    line("")

    # 章节（chapter_id 为题目上的字符串键；无独立表，包按 chapter_id 绑定，P0-5）
    line("-- 五专题章节（chapter_id 为题目上的字符串键；包按 chapter_id 绑定，P0-5）")
    line("")
    line("-- ── 知识点 K（26 条，5 专题三级结构） ──")
    for kid, module, name, standard, advice in KNOWLEDGE:
        line(f"insert into content_knowledge_component(dimension_id, tenant_id, name, payload) values")
        line(f"  ('{kid}', '{TENANT}', '{name}', {JQ({'dimension_id': kid, 'name': name, 'module': module, 'mastery_standard': standard, 'remedial_advice': advice})})")
        line("on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;")
    line("")
    line("-- ── 题型 T（20 条） ──")
    for tid, name, ask, steps, points in QUESTION_TYPES:
        line(f"insert into content_question_type(dimension_id, tenant_id, name, payload) values")
        line(f"  ('{tid}', '{TENANT}', '{name}', {JQ({'dimension_id': tid, 'name': name, 'typical_ask': ask, 'standard_steps': steps, 'scoring_points': points})})")
        line("on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;")
    line("")
    line("-- ── 错因 E（20 条） ──")
    for eid, cat, name, form, basis, remedy in ERROR_CAUSES:
        line(f"insert into content_error_cause(dimension_id, tenant_id, name, payload) values")
        line(f"  ('{eid}', '{TENANT}', '{name}', {JQ({'dimension_id': eid, 'name': name, 'category': cat, 'manifestation': form, 'judgment_basis': basis, 'remedial_advice': remedy})})")
        line("on conflict (dimension_id) do update set name = excluded.name, payload = excluded.payload;")
    line("")
    line("-- ── 诊断规则 R（20 条，dimension_ids 关联 K/T，供题目关联诊断上下文，P0-7） ──")
    for rid, trigger, cand, probe, dims in DIAGNOSIS_RULES:
        line(f"insert into content_diagnosis_rule(rule_id, tenant_id, rule_version, payload) values")
        line(f"  ('{rid}', '{TENANT}', '1.0.0', {JQ({'rule_id': rid, 'trigger': trigger, 'candidate_error_causes': cand, 'probe': probe, 'dimension_ids': dims})})")
        line("on conflict (rule_id) do update set rule_version = excluded.rule_version, payload = excluded.payload;")
    line("")

    # 题目
    line("-- ── 题目 Q（82 道 = 80 新题 + 2 试点题，含评分点与测量目标；数值经人工验算） ──")
    for q in QUESTIONS:
        qid = q[0]
        mts = q_json(q)["measurement_targets"]
        dims = [m["dim"] for m in mts]
        line(f"insert into content_question(question_id, tenant_id, chapter_id, question_version, stem_format, tags, measurement_dims, published, payload) values")
        line(f"  ('{qid}', '{TENANT}', '{q[1]}', 1, 'open_solution', {JA(q[5])}, {JA(dims)}, true, {JQ(q_json(q))}::jsonb)")
        line("on conflict (question_id) do update set payload = excluded.payload, measurement_dims = excluded.measurement_dims, tags = excluded.tags, published = true;")
        # 测量目标（P0-6 观测归因依据）
        line(f"insert into content_measurement_target(tenant_id, question_id, dim, role, evidence_rule) values")
        mt_rows = ",\n".join(
            f"  ('{TENANT}', '{qid}', '{m['dim']}', '{m['role']}', '{m['evidence_rule']}')" for m in mts)
        line(mt_rows)
        line("on conflict (question_id, dim) do update set role = excluded.role, evidence_rule = excluded.evidence_rule;")
        # 血缘（人工审定内容，§7.3）
        line(f"insert into content_field_lineage (tenant_id, entity_type, entity_id, field_path, derivation_type, provenance_status, reviewer_id, review_decision, confidence)")
        line(f"values")
        line(f"  ('{TENANT}', 'question', '{qid}', '/stem_markdown', 'teacher_edit', 'human_authored', '{TEACHER}', 'confirmed', 1.0),")
        line(f"  ('{TENANT}', 'question', '{qid}', '/rubric', 'teacher_edit', 'human_authored', '{TEACHER}', 'confirmed', 1.0),")
        line(f"  ('{TENANT}', 'question', '{qid}', '/measurement_targets', 'teacher_edit', 'human_authored', '{TEACHER}', 'confirmed', 1.0);")
    line("")

    # 章节包（chapter_id 绑定，P0-5 证据链）
    line("-- ── 已发布章节包（chapter_id 绑定 + 章节作用域 contents，P0-5） ──")
    line(f"insert into content_chapter_package (package_id, tenant_id, chapter_id, version, manifest_hash, published_by, published_at, payload)")
    line("values")
    pkg_rows = []
    for cid, _ in CHAPTERS:
        contents = package_contents(cid)
        import hashlib
        mhash = "sha256:" + hashlib.sha256(json.dumps(contents, ensure_ascii=False, sort_keys=True).encode()).digest().hex()
        pkg_rows.append(f"  ('pkg_{cid}_001', '{TENANT}', '{cid}', '1.0.0', '{mhash}', '{TEACHER}', now(), {JQ({'package_id': f'pkg_{cid}_001', 'tenant_id': TENANT, 'chapter_id': cid, 'version': '1.0.0', 'manifest_hash': mhash, 'contents': contents, 'published_by': TEACHER, 'published_at': NOW, 'note': '专题章节已发布包'})})")
    line(",\n".join(pkg_rows))
    line("on conflict (package_id) do nothing;")
    line("")
    line("-- 试点章节包（Q_TRI_012/Q_TRI_020 演示基线）")
    line(f"insert into content_chapter_package (package_id, tenant_id, chapter_id, version, manifest_hash, published_by, published_at, payload)")
    line(f"values ('pkg_tri_pilot_001', '{TENANT}', 'chap_tri_pilot', '0.1.0', 'sha256:pilot-chapter-package-v0.1.0', '{TEACHER}', now(),")
    line(f"  {JQ({'package_id': 'pkg_tri_pilot_001', 'tenant_id': TENANT, 'chapter_id': 'chap_tri_pilot', 'version': '0.1.0', 'manifest_hash': 'sha256:pilot-chapter-package-v0.1.0', 'contents': {'knowledge_components': ['K_SINE_RULE', 'K_SSA', 'K_TRIANGLE_EXISTENCE'], 'question_types': ['T_SSA_SOLVE'], 'error_causes': ['E_SSA_MISSING_OBTUSE'], 'questions': ['Q_TRI_012', 'Q_TRI_020'], 'diagnosis_rules': ['R_SSA_BRANCH_CHECK']}, 'published_by': TEACHER, 'note': 'dev 试点已发布包'})})")
    line("on conflict (package_id) do nothing;")
    line("")

    # ── 案例 1：usr_student01（case_002 高二 95→115，分类讨论不全） ──
    line("-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student01 高二·95→115 ═══════════")
    case1_sessions = [
        {
            "session_id": "s_demo_01a", "question_id": "Q_TRI_012",
            "ser_id": "ser_demo_01a", "tss_id": "tss_demo_01a", "slr_id": "slr_demo_01a",
            "summary": "学生能独立列出正弦定理并解出 sinB=1/√3，但第一次遗漏 SSA 补角分支；补角判断题卡作答正确后自行修正。",
            "attempts": [
                {"attempt_id": "att_demo_01a_1", "judgment_id": "jud_demo_01a_1", "verdict": "partially_correct", "kind": "answer",
                 "answer_text": "由正弦定理 sinB = b·sinA/a = 1/√3，故 B ≈ 35.3°。",
                 "decision_summary": "正弦定理列出正确；仅给出锐角解，遗漏 144.7° 补角分支。",
                 "rubric_items": [{"id": "setup_sine_rule", "status": "met"}, {"id": "ssa_branch_check", "status": "not_met"}],
                 "claim": {"claim_id": "clm_demo_01a", "status": "resolved", "resolved": True,
                           "candidates": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "confidence": 0.85, "evidence": "只给锐角解"}],
                           "probe": {"question": "sinB=1/√3 时 B 的可能值有哪些？", "judge_rubric": "能列出 35.3° 与 144.7° 两解且验证均满足 A+B<180°"},
                           "card_id": "card_demo_01a", "rationale": "典型 SSA 补角遗漏", "probe_history": []}},
                {"attempt_id": "att_demo_01a_2", "judgment_id": "jud_demo_01a_2", "verdict": "correct", "kind": "probe",
                 "answer_text": "sinB=1/√3 时 B ≈ 35.3° 或 144.7°，两解均满足 A+B<180°。",
                 "decision_summary": "补角分支完整，两解均合法。",
                 "rubric_items": [{"id": "probe.judge", "status": "met"}]},
            ],
        },
        {
            "session_id": "s_demo_01b", "question_id": "Q_TRI_020",
            "ser_id": "ser_demo_01b", "tss_id": "tss_demo_01b", "slr_id": "slr_demo_01b",
            "summary": "独立完成 SSA 两解讨论，正确给出 45° 与 135° 并验证存在性；分类讨论习惯已建立。",
            "attempts": [
                {"attempt_id": "att_demo_01b_1", "judgment_id": "jud_demo_01b_1", "verdict": "correct", "kind": "answer",
                 "answer_text": "sinB = b·sinA/a = √2/2，B = 45° 或 135°，两解均满足 A+B<180°。",
                 "decision_summary": "正弦定理正确，两解讨论完整。",
                 "rubric_items": [{"id": "setup_sine_rule", "status": "met"}, {"id": "ssa_branch_check", "status": "met"}]},
            ],
        },
    ]
    build_case("usr_student01",
               {"grade": "高二", "current_score": 95, "target_score": 115, "weekly_hours": "7-10", "self_weak": ["K_SSA"], "device_draft": "触屏手写"},
               case1_sessions,
               {
                   "_ids": {"decision_id": "pud_demo_01", "validation_id": "pvr_demo_01", "snapshot_id": "snap_demo_01"},
                   "K_SSA": {"uncertainty": "medium", "ledger": [
                       {"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0,
                        "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_1"],
                        "explanation": "次题独立完成两解讨论，补角分支方法迁移成功"},
                       {"code": "SELF_CORRECTION_RECURS", "rubric_bin": "clear", "lr_used": 2.0,
                        "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_2"],
                        "explanation": "追问后自行发现并修正补角遗漏"}],
                    },
                   "K_SINE_RULE": {"uncertainty": "low", "ledger": [
                       {"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0,
                        "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01a_1"],
                        "explanation": "两题正弦定理列式稳定正确"},
                       {"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3,
                        "session_refs": ["s_demo_01a", "s_demo_01b"], "evidence_refs": ["obs_s_demo_01b_1"],
                        "explanation": "方法选择稳定"}],
                    },
                   "misconceptions": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "state": "confirmed", "evidence_refs": ["claim://clm_demo_01a"]}],
               },
               "先补 SSA 解的个数讨论（分类讨论专项），再练正弦定理迁移，最后延迟复测验证保持率。",
               {"K_SSA": {"state": "learning"}, "K_SINE_RULE": {"state": "possibly_mastered"}})

    # ── 案例 2：usr_student02（case_001 高一 60→90，公式适用条件不清） ──
    line("-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student02 高一·60→90 ═══════════")
    case2_sessions = [
        {
            "session_id": "s_demo_02a", "question_id": "Q_BAS_003",
            "ser_id": "ser_demo_02a", "tss_id": "tss_demo_02a", "slr_id": "slr_demo_02a",
            "summary": "正弦定理比例式写出，代入时 sin45° 值用错导致结果偏差；追问卡跳过（学生未作答），证据留待后续会话确认。",
            "attempts": [
                {"attempt_id": "att_demo_02a_1", "judgment_id": "jud_demo_02a_1", "verdict": "partially_correct", "kind": "answer",
                 "answer_text": "a/sin60° = 2√2/sin45° → a = 2√2·(√3/2)/(√2/2)·(1/2)，算得 a=√3。",
                 "decision_summary": "正弦定理列式正确；代入运算出错（sin45° 值或约分错误），结果应为 2√3。",
                 "rubric_items": [{"id": "setup_sine_rule", "status": "met"}, {"id": "solve_side", "status": "not_met"}],
                 "claim": {"claim_id": "clm_demo_02a", "status": "skipped", "resolved": False,
                           "candidates": [{"error_cause_id": "E_COMPUTE_SLIP", "confidence": 0.6, "evidence": "代入运算偏差"}, {"error_cause_id": "E_FORMULA_MISUSE", "confidence": 0.4, "evidence": "列式正确但结果偏差"}],
                           "probe": {"question": "sin45° 与 sin60° 的值分别是多少？重算 a 的值。", "judge_rubric": "正确写出特殊角正弦值并算得 a=2√3"},
                           "card_id": "card_demo_02a", "rationale": "运算环节出错", "probe_history": []}},
            ],
        },
        {
            "session_id": "s_demo_02b", "question_id": "Q_BAS_002",
            "ser_id": "ser_demo_02b", "tss_id": "tss_demo_02b", "slr_id": "slr_demo_02b",
            "summary": "能由正弦定理解出 sinB=√2/2，但只取 45° 一个解，遗漏 135° 补角；追问未答，错因待观察。",
            "attempts": [
                {"attempt_id": "att_demo_02b_1", "judgment_id": "jud_demo_02b_1", "verdict": "incorrect", "kind": "answer",
                 "answer_text": "sinB = b·sinA/a = √2/2，所以 B = 45°。",
                 "decision_summary": "正弦定理正确但漏 135° 分支，分类讨论不完整。",
                 "rubric_items": [{"id": "setup_sine_rule", "status": "met"}, {"id": "ssa_branch_check", "status": "not_met"}],
                 "claim": {"claim_id": "clm_demo_02b", "status": "unresolved", "resolved": False,
                           "candidates": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "confidence": 0.9, "evidence": "只给锐角解"}],
                           "probe": {"question": "sinB=√2/2 时 B 的可能值有哪些？", "judge_rubric": "能列出 45° 与 135° 两解"},
                           "card_id": "card_demo_02b", "rationale": "典型 SSA 补角遗漏，追问未闭合", "probe_history": []}},
            ],
        },
    ]
    build_case("usr_student02",
               {"grade": "高一", "current_score": 60, "target_score": 90, "weekly_hours": "4-6", "self_weak": ["K_SINE_RULE"], "device_draft": "无草稿"},
               case2_sessions,
               {
                   "_ids": {"decision_id": "pud_demo_02", "validation_id": "pvr_demo_02", "snapshot_id": "snap_demo_02"},
                   "K_SINE_RULE": {"uncertainty": "high", "ledger": [
                       {"code": "TRANSFER_FAILURE_DISTINCT_CONTEXT", "rubric_bin": "unclear", "lr_used": 0.5,
                        "session_refs": ["s_demo_02a", "s_demo_02b"], "evidence_refs": ["obs_s_demo_02a_1", "obs_s_demo_02b_1"],
                        "explanation": "两题正弦定理列式正确但运算环节不稳（一次运算失误、一次分类遗漏），证据不足以下调，保守保持基准"}],
                    },
                   "K_SSA": {"uncertainty": "high", "ledger": [
                       {"code": "TRANSFER_FAILURE_DISTINCT_CONTEXT", "rubric_bin": "unclear", "lr_used": 0.5,
                        "session_refs": ["s_demo_02a", "s_demo_02b"], "evidence_refs": ["obs_s_demo_02b_2"],
                        "explanation": "补角分支遗漏且追问未闭合，维持低掌握估计"}],
                    },
                   "misconceptions": [{"error_cause_id": "E_SSA_MISSING_OBTUSE", "state": "suspected", "evidence_refs": ["claim://clm_demo_02b"]},
                                      {"error_cause_id": "E_COMPUTE_SLIP", "state": "suspected", "evidence_refs": ["claim://clm_demo_02a"]}],
               },
               "基础薄弱：先补正弦定理公式与特殊角值（知识补讲+低一档练习），再专项训练 SSA 分类讨论，最后迁移与延迟复测。",
               {"K_SINE_RULE": {"state": "insufficient_evidence"}, "K_SSA": {"state": "insufficient_evidence"}})

    # ── 案例 3：usr_student03（case_003 高三 120→135，冲高分） ──
    line("-- ═══════════ 演示案例（黄金数据，§17.2）：usr_student03 高三·120→135 ═══════════")
    case3_sessions = [
        {
            "session_id": "s_demo_03a", "question_id": "Q_EXT_003",
            "ser_id": "ser_demo_03a", "tss_id": "tss_demo_03a", "slr_id": "slr_demo_03a",
            "summary": "余弦定理展开后直接用基本不等式求下界，取等条件说明完整（a=b=4），一次通过。",
            "attempts": [
                {"attempt_id": "att_demo_03a_1", "judgment_id": "jud_demo_03a_1", "verdict": "correct", "kind": "answer",
                 "answer_text": "c²=(a+b)²−3ab ≥ 64−3·16=16，a=b=4 时取等 → c_min=4。",
                 "decision_summary": "余弦定理与基本不等式应用正确，取等条件完整。",
                 "rubric_items": [{"id": "cosine_expand", "status": "met"}, {"id": "inequality_apply", "status": "met"}]},
            ],
        },
        {
            "session_id": "s_demo_03b", "question_id": "Q_EXT_009",
            "ser_id": "ser_demo_03b", "tss_id": "tss_demo_03b", "slr_id": "slr_demo_03b",
            "summary": "周长条件下的面积最值，不等式与取等处理一次通过（a=b=2）。",
            "attempts": [
                {"attempt_id": "att_demo_03b_1", "judgment_id": "jud_demo_03b_1", "verdict": "correct", "kind": "answer",
                 "answer_text": "c²=a²+b²−ab ≥ (a+b)²/4 → c≥2，a=b=2 时取等 → S_max=√3。",
                 "decision_summary": "不等式方向与取等验证完整。",
                 "rubric_items": [{"id": "area_expression", "status": "met"}, {"id": "inequality_apply", "status": "met"}]},
            ],
        },
        {
            "session_id": "s_demo_03c", "question_id": "Q_EXT_004",
            "ser_id": "ser_demo_03c", "tss_id": "tss_demo_03c", "slr_id": "slr_demo_03c",
            "summary": "面积上界算出但取等条件 a=b=5 未验证可达；追问后确认取等成立，结论修正为 25√3/4。",
            "attempts": [
                {"attempt_id": "att_demo_03c_1", "judgment_id": "jud_demo_03c_1", "verdict": "partially_correct", "kind": "answer",
                 "answer_text": "S=√3ab/4，a+b=10 → ab≤25 → S≤25√3/4。",
                 "decision_summary": "ab 上界正确但未说明取等条件 a=b=5 能否同时满足三角形条件。",
                 "rubric_items": [{"id": "area_expression", "status": "met"}, {"id": "inequality_apply", "status": "not_met"}],
                 "claim": {"claim_id": "clm_demo_03c", "status": "resolved", "resolved": True,
                           "candidates": [{"error_cause_id": "E_RANGE_END_MISS", "confidence": 0.8, "evidence": "未验证取等可达"}],
                           "probe": {"question": "a=b=5 时 C=60° 的三角形存在吗？验证取等。", "judge_rubric": "验证 a=b=5、C=60° 构成三角形（等边）"},
                           "card_id": "card_demo_03c", "rationale": "取等条件遗漏", "probe_history": []}},
                {"attempt_id": "att_demo_03c_2", "judgment_id": "jud_demo_03c_2", "verdict": "correct", "kind": "probe",
                 "answer_text": "a=b=5、C=60° 时 c=5，构成等边三角形 ✓，取等可达，S_max=25√3/4。",
                 "decision_summary": "取等验证完整。",
                 "rubric_items": [{"id": "probe.judge", "status": "met"}]},
            ],
        },
    ]
    build_case("usr_student03",
               {"grade": "高三", "current_score": 120, "target_score": 135, "weekly_hours": "10+", "self_weak": [], "device_draft": "纸面拍照"},
               case3_sessions,
               {
                   "_ids": {"decision_id": "pud_demo_03", "validation_id": "pvr_demo_03", "snapshot_id": "snap_demo_03"},
                   "K_INEQUALITY": {"uncertainty": "low", "ledger": [
                       {"code": "TRANSFER_SUCCESS_DISTINCT_CONTEXT", "rubric_bin": "clear", "lr_used": 2.0,
                        "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03a_1"],
                        "explanation": "两题不等式配凑方法独立使用正确"},
                       {"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3,
                        "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03b_2"],
                        "explanation": "不同题型背景下方法选择稳定"}],
                    },
                   "T_INEQUALITY_APPLY": {"uncertainty": "low", "ledger": [
                       {"code": "METHOD_STABLE_ACROSS_CONTEXTS", "rubric_bin": "clear", "lr_used": 1.3,
                        "session_refs": ["s_demo_03a", "s_demo_03b"], "evidence_refs": ["obs_s_demo_03a_2"],
                        "explanation": "最值题型方法选择稳定，取等经追问验证后修正"}],
                    },
                   "misconceptions": [{"error_cause_id": "E_RANGE_END_MISS", "state": "improving", "evidence_refs": ["claim://clm_demo_03c"]}],
               },
               "冲高分路径：不等式与面积最值取等专项（含取等验证习惯），再综合迁移与限时训练。",
               {"K_INEQUALITY": {"state": "learning"}, "T_INEQUALITY_APPLY": {"state": "learning"}})

    line("")
    line("-- fixtures 显式作为公共教学库发布，并建立演示教师的学生绑定。")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'knowledge_component',dimension_id,'public',null from content_knowledge_component on conflict do nothing;")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'question_type',dimension_id,'public',null from content_question_type on conflict do nothing;")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'error_cause',dimension_id,'public',null from content_error_cause on conflict do nothing;")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'diagnosis_rule',rule_id,'public',null from content_diagnosis_rule on conflict do nothing;")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'question',question_id,'public',null from content_question on conflict do nothing;")
    line("insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id) select tenant_id,'chapter_package',package_id,'public',null from content_chapter_package on conflict do nothing;")
    for index, student_id in enumerate(["usr_student01", "usr_student02", "usr_student03"], start=1):
        line("insert into identity_teacher_student_binding(binding_id,tenant_id,teacher_id,student_id,status,created_by,payload) "
             f"values ('bind_fixture_{index:02d}','tnt_dev00001','usr_teacher01','{student_id}','active','usr_teacher01','{{\"source\":\"fixtures\"}}') on conflict do nothing;")
    line("")
    line("commit;")


if __name__ == "__main__":
    emit()
    print("\n".join(OUT))
