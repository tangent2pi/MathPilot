#!/usr/bin/env bash
# 无外部密钥确定性回归。
# 前置：显式加载合成 fixtures 后启动服务：
# docker compose --profile fixtures run --rm db-fixtures && docker compose up -d
# 正常内容流程不得加载 fixtures；应由教师上传教学资料批次生成数据库。
# 覆盖：P0-5 包版本证据链 / P0-6 维度校验 / P0-7 诊断上下文关联 / P0-8 Validator 拒绝路径 /
#       P0-10 计划周界 / P1 测评预算强制与主动结束会话 / 学生题面与 KTQRE 权限边界 /
#       内容范围、教师绑定和导出接口。
set -eu
API="${API:-http://localhost:8080/api}"
TENANT="tnt_dev00001"
FAIL=0
COOKIE_DIR=$(mktemp -d /tmp/agmath-no-key.XXXXXX)
trap 'rm -rf -- "$COOKIE_DIR"' EXIT
STUDENT_COOKIE="$COOKIE_DIR/student.cookie"
TEACHER_COOKIE="$COOKIE_DIR/teacher.cookie"

curl -fsS -c "$STUDENT_COOKIE" -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -d "{\"email\":\"${BETTER_AUTH_STUDENT_EMAIL:-student@mathpilot.local}\",\"password\":\"${BETTER_AUTH_STUDENT_PASSWORD:-MathPilotStudent123!}\",\"rememberMe\":false}" \
  "$API/auth/sign-in/email" >/dev/null
curl -fsS -c "$TEACHER_COOKIE" -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
  -d "{\"email\":\"${BETTER_AUTH_TEACHER_EMAIL:-teacher@mathpilot.local}\",\"password\":\"${BETTER_AUTH_TEACHER_PASSWORD:-MathPilotTeacher123!}\",\"rememberMe\":false}" \
  "$API/auth/sign-in/email" >/dev/null

student() { curl -s -b "$STUDENT_COOKIE" "$@"; }
teacher() { curl -s -b "$TEACHER_COOKIE" "$@"; }

check() { # $1 描述 $2 断言命令
  if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; FAIL=1; fi
}

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# ── 权限边界：学生题面不泄露判答规格，KTQRE 全库仅教师/内部教学 Agent 可读 ──
SAFE_Q=$(student "$API/questions/Q_BAS_001")
check "学生题面不泄露答案/rubric/测量目标" "echo '$SAFE_Q' | json \"'answer' not in d and 'rubric' not in d and 'measurement_targets' not in d\" | grep -q True"
STUDENT_LIBRARY_STATUS=$(student -o /dev/null -w '%{http_code}' "$API/library")
TEACHER_LIBRARY_STATUS=$(teacher -o /dev/null -w '%{http_code}' "$API/library")
STUDENT_LIST_STATUS=$(student -o /dev/null -w '%{http_code}' "$API/questions")
check "学生不可读 KTQRE 全库" "test '$STUDENT_LIBRARY_STATUS' = 403"
check "学生不可读内部题目候选列表" "test '$STUDENT_LIST_STATUS' = 403"
check "教师可读 KTQRE 全库" "test '$TEACHER_LIBRARY_STATUS' = 200"

# 学生即使修改路径中的 student_id，也只会得到自己的历史。
HISTORY=$(student "$API/students/usr_student03/history")
check "学生历史接口强制 self" "echo '$HISTORY' | json \"d['student_id']\" | grep -q '^usr_student01$'"

# ── 教学绑定：教师看到绑定学生；学生可以确认当前教师 ──
OVERVIEW=$(teacher "$API/admin/overview")
check "教师工作台返回已绑定学生" "echo '$OVERVIEW' | json \"len(d['students'])\" | grep -q '^3$'"
MY_TEACHER=$(student "$API/my-teacher")
check "学生可查看当前绑定教师" "echo '$MY_TEACHER' | json \"d['binding']['teacher_id']\" | grep -q '^usr_teacher01$'"
EXPORT_STATUS=$(teacher -o /dev/null -w '%{http_code}' "$API/admin/export?format=csv&dataset=questions")
check "教师 CSV 导出可用" "test '$EXPORT_STATUS' = 200"

# ── P0-5 包版本证据链：伪造版本必须被拒绝，真实版本通过 ──
BAD=$(student -X POST "$API/sessions" -H 'content-type: application/json' \
  -d '{"student_id":"usr_student02","question_id":"Q_BAS_001","chapter_package_version":"9.9.9","mode":"diagnostic","draft_enabled":false}')
check "P0-5 伪造包版本 → 422" "echo '$BAD' | json \"d['error']\" | grep -q chapter_package_version_invalid"
GOOD=$(student -X POST "$API/sessions" -H 'content-type: application/json' \
  -d '{"student_id":"usr_student02","question_id":"Q_BAS_001","chapter_package_version":"1.0.0","mode":"diagnostic","draft_enabled":false}')
check "P0-5 真实包版本 → 201" "echo '$GOOD' | json \"d.get('session_id','')\" | grep -q '^s_'"

# ── P0-6 维度校验：非测量目标维度在模型调用前被拒（无 key 环境即证明：未 502 而是 422） ──
SID=$(echo "$GOOD" | json "d['session_id']")
R=$(student -X POST "$API/sessions/$SID/submit" -H 'content-type: application/json' \
  -d '{"answer_text":"x","dimension_id":"E_HACK_01"}')
check "P0-6 非法维度 → 422（模型前拒绝）" "echo '$R' | json \"d['error']\" | grep -q dimension_id_not_in_measurement_targets"

# ── P0-7 诊断上下文题目关联：Q_BAS_002 只含 SSA 相关 E/R ──
CTX=$(teacher "$API/content/questions/Q_BAS_002/diagnosis-context")
check "P0-7 题目关联错因（E 属 SSA 家族）" "echo '$CTX' | json \"','.join(e['dimension_id'] for e in d['error_causes'])\" | grep -q E_SSA_MISSING_OBTUSE"
check "P0-7 不含无关错因（E_TANGENT）" "echo '$CTX' | json \"all(e['dimension_id'] != 'E_TANGENT_DENOM_ZERO' for e in d['error_causes'])\" | grep -q True"

# ── P1 测评轮：self_weak 写入 + 预算强制 ──
RUN=$(student -X POST "$API/assessment-runs" -H 'content-type: application/json' \
  -d '{"student_id":"usr_student01","budget":{"max_questions":2}}')
RID=$(echo "$RUN" | json "d['run_id']")
check "P1 self_weak 写入 run" "echo '$RUN' | json \"d['self_weak']\" | grep -q K_SSA"
N1=$(student -X POST "$API/assessment-runs/$RID/next")
N2=$(student -X POST "$API/assessment-runs/$RID/next")
check "P1 next 返回题目" "echo '$N1' | json \"d.get('question_id','')\" | grep -q '^Q_'"
N3=$(student -o /dev/null -w '%{http_code}' -X POST "$API/assessment-runs/$RID/next")
check "P1 题量预算强制 → 409" "test \"$N3\" = 409"

# ── P1 学生主动结束：无作答会话直接 CLOSED ──
SID2=$(student -X POST "$API/sessions" -H 'content-type: application/json' \
  -d '{"student_id":"usr_student02","question_id":"Q_BAS_002","chapter_package_version":"1.0.0","mode":"diagnostic","draft_enabled":false}' | json "d['session_id']")
CLOSE=$(student -X POST "$API/sessions/$SID2/close")
check "P1 主动结束 → CLOSED(student_ended)" "echo '$CLOSE' | json \"d.get('termination_reason','')\" | grep -q student_ended"

# ── P0-10 计划周界：horizon=1 时全部任务落在第 1 周 ──
PLAN=$(student -X POST "$API/students/usr_student01/plans" -H 'content-type: application/json' -d '{"horizon_weeks":1}')
check "P0-10 horizon=1 无周 2+ 任务" "echo '$PLAN' | json \"all(t['week']==1 for t in d.get('tasks',[]))\" | grep -q True"

# ── P0-8 Dream Validator：p_baseline 与 Roster 不符 → 拒绝 ──
# /dream/validate 必须从数据库权威观测幂等重放 Roster，不能依赖宿主机残留 JSONL 状态。
V=$(curl -s -X POST "http://localhost:3003/dream/validate" -H 'content-type: application/json' -d '{
  "student_id":"usr_student01","prior_snapshot_id":null,
  "baseline_report_refs":["ser_demo_01a"],"teaching_summary_refs":["tss_demo_01a"],
  "dimension_updates":[{"dimension_id":"K_SSA","p_baseline":0.9,"p_final":0.9,"state_final":"learning","uncertainty":"low","evidence_ledger":[]}],
  "semantic_profile_updates":[],"review_required":false,
  "model_id":"t","prompt_version":"t","skill_version":"t","created_at":"x"}')
check "P0-8 Validator 拒绝错误基准" "echo '$V' | json \"any(not c['passed'] for c in d['checks'] if c['check']=='baseline_matches_program')\" | grep -q True"

echo
if [ "$FAIL" = 0 ]; then echo "NO-KEY SMOKE PASS"; else echo "NO-KEY SMOKE FAILED"; exit 1; fi
