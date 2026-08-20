#!/usr/bin/env bash
# 参赛六表导出（交付物 #3）：从 PostgreSQL 派生导出到 data/（设计 §7.4：CSV 只是一时生成的交付格式，不是运行时数据源）。
# 用法：bash deploy/dev/export-data.sh（需本地 postgres 运行；或改 DATABASE_URL）
set -eu
cd "$(dirname "$0")/../.."

: "${DATABASE_URL:=postgres://agmath_app:agmath-app-dev-only@localhost:5432/agmath}"
OUT="${1:-data}"
mkdir -p "$OUT"

psql_csv() { # $1=带列别名的 SELECT -> PostgreSQL 原生 CSV（负责引号、逗号和换行转义）
  local sql="$1"
  docker exec -i agmath-dev-postgres-1 psql -U agmath -d agmath \
    -c "\\copy ($sql) to stdout with (format csv, header true)" 2>/dev/null \
    || psql "$DATABASE_URL" -c "\\copy ($sql) to stdout with (format csv, header true)"
}

# ── 1) knowledge_points.csv（赛题建议字段：knowledge_id/模块/三级知识点/难度/前置/掌握标准/补弱建议） ──
psql_csv "select k.payload->>'dimension_id' as \"knowledge_id\",
                  k.payload->>'module' as \"一级模块\",
                  '' as \"二级模块\",
                  k.payload->>'name' as \"三级知识点\",
                  '中' as \"难度\",
                  '' as \"前置知识点\",
                  k.payload->>'mastery_standard' as \"掌握标准\",
                  k.payload->>'remedial_advice' as \"补弱建议\"
            from content_knowledge_component k
            order by 1" > "$OUT/knowledge_points.csv"

# ── 2) question_types.csv ──
psql_csv "select t.payload->>'dimension_id' as \"type_id\",
                  t.payload->>'name' as \"题型名称\",
                  '' as \"关联知识点\",
                  t.payload->>'typical_ask' as \"典型问法\",
                  t.payload->>'standard_steps' as \"标准步骤\",
                  t.payload->>'scoring_points' as \"评分点\",
                  '' as \"训练顺序\"
            from content_question_type t order by 1" > "$OUT/question_types.csv"

# ── 3) error_causes.csv ──
psql_csv "select e.payload->>'dimension_id' as \"error_id\",
                  e.payload->>'category' as \"错因大类\",
                  e.payload->>'name' as \"错因名称\",
                  e.payload->>'manifestation' as \"表现形式\",
                  e.payload->>'judgment_basis' as \"判断依据\",
                  e.payload->>'remedial_advice' as \"补救建议\"
            from content_error_cause e order by 1" > "$OUT/error_causes.csv"

# ── 4) questions.csv ──
psql_csv "select q.question_id as \"question_id\",
                  case when q.question_id like 'Q_TRI%' then '试点自建' else '附件01-05改编' end as \"来源\",
                  '解答题' as \"题型\",
                  q.payload->>'stem_markdown' as \"题干\",
                  '' as \"选项\",
                  q.payload->'answer'->>'summary' as \"答案\",
                  q.payload->'answer'->>'summary' as \"解析\",
                  array_to_string(array(select x from unnest(q.tags) x where x like 'K\_%'), '|') as \"知识点ID\",
                  array_to_string(array(select x from unnest(q.tags) x where x like 'T\_%'), '|') as \"题型ID\",
                  '' as \"常见错因ID\",
                  '中' as \"难度\"
            from content_question q where q.published order by 1" > "$OUT/questions.csv"

# ── 5) diagnosis_rules.csv ──
psql_csv "select r.payload->>'rule_id' as \"rule_id\",
                  r.payload->>'trigger' as \"触发条件\",
                  array_to_string(array(select e from jsonb_array_elements_text(r.payload->'dimension_ids') e where e like 'K\_%'), '|') as \"知识点ID\",
                  array_to_string(array(select e from jsonb_array_elements_text(r.payload->'dimension_ids') e where e like 'T\_%'), '|') as \"题型ID\",
                  array_to_string(array(select e from jsonb_array_elements_text(r.payload->'candidate_error_causes') e), '|') as \"错因ID\",
                  r.payload->>'trigger' as \"诊断结论\",
                  r.payload->>'probe' as \"学习建议\",
                  '1' as \"优先级\"
            from content_diagnosis_rule r order by 1" > "$OUT/diagnosis_rules.csv"

# ── 6) student_cases.csv（与 data/student_cases.md 对齐） ──
cat > "$OUT/student_cases.csv" <<'CSV'
case_id,学生画像,目标分,作答记录,期望诊断重点,期望学习计划方向
case_001,高一/60分/每周4-6h/无草稿,90,2 题（Q_BAS_003 部分正确+追问跳过；Q_BAS_002 不正确+追问未答）,正弦定理列式正确但运算/分类不稳；E_SSA_MISSING_OBTUSE 与 E_COMPUTE_SLIP suspected；K_SINE_RULE/K_SSA 证据不足,知识补讲（公式+特殊角）→低一档练习→SSA 分类专项→延迟复测
case_002,高二/95分/每周7-10h/触屏手写,115,2 题（Q_TRI_012 部分正确+补角追问答对；Q_TRI_020 正确）,SSA 补角分支遗漏→追问闭合；K_SSA learning(0.49)；K_SINE_RULE possibly_mastered(0.96)；E_SSA_MISSING_OBTUSE confirmed,分类讨论专项（原难度）→迁移题→延迟复测
case_003,高三/120分/每周10+h/纸面拍照,135,3 题（Q_EXT_003/Q_EXT_009 正确；Q_EXT_004 部分正确+取等追问答对）,最值题型取等条件遗漏→追问闭合；K_INEQUALITY possibly_mastered(0.99)；T_INEQUALITY_APPLY weak(0.24)；E_RANGE_END_MISS improving,不等式/最值取等专项→综合迁移→限时训练
CSV

echo "导出完成：$OUT/"
wc -l "$OUT"/*.csv
