#!/usr/bin/env bash
# 保留当前真实/测试内容数据时的无成本在线回归：不创建内容，不调用模型或 OCR。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
BASE="${BASE:-http://localhost:8080}"
API="$BASE/api"
temporary="$(mktemp -d /tmp/mathpilot-current-state.XXXXXX)"
trap 'rm -rf -- "$temporary"' EXIT
student_cookie="$temporary/student.cookie"
teacher_cookie="$temporary/teacher.cookie"

login() {
  local email="$1" password="$2" cookie="$3"
  curl -fsS -c "$cookie" -H "origin: $BASE" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\",\"rememberMe\":false}" \
    "$API/auth/sign-in/email" >/dev/null
}

login "${BETTER_AUTH_STUDENT_EMAIL:-student@mathpilot.local}" "${BETTER_AUTH_STUDENT_PASSWORD:-MathPilotStudent123!}" "$student_cookie"
login "${BETTER_AUTH_TEACHER_EMAIL:-teacher@mathpilot.local}" "${BETTER_AUTH_TEACHER_PASSWORD:-MathPilotTeacher123!}" "$teacher_cookie"

student() { curl -fsS -b "$student_cookie" "$@"; }
teacher() { curl -fsS -b "$teacher_cookie" "$@"; }
status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

student "$API/me" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "student" in d["roles"]'
teacher "$API/me" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("teacher_user_id="+str(d.get("user_id"))); assert any(r in d["roles"] for r in ("teacher","tenant_admin"))'
test "$(status -b "$student_cookie" "$API/library")" = 403
# 正式库在教师发布前保持为空；84 道暂存题应从本人复核队列恢复，而不是提前泄露到已发布库。
teacher "$API/library" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["questions"]) == 0'
teacher "$API/review/tasks?queue=content" | python3 -c 'import json,sys; d=json.load(sys.stdin); n=sum(t.get("target_type")=="question" for t in d["tasks"]); print(f"teacher_staged_questions={n}"); assert n == 84'
teacher "$API/review/tasks?status=pending&target_type=question&limit=12&offset=0" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["tasks"]) == 12 and d["pending_count"] == 84 and d["limit"] == 12 and d["offset"] == 0'
teacher "$API/review/tasks?status=pending&q=Q_SIN_001&limit=12" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d["tasks"]) == 1 and d["pending_count"] == 1 and d["tasks"][0]["target_id"] == "Q_SIN_001"'
teacher "$API/content/questions/Q_SIN_011/review" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["published_packages"] == [] and len(d["assets"]) == 2 and d["source_evidence"]; assert all(s["source_fragment_id"] and s["document_id"] and s["page_no"] for s in d["source_evidence"]); assert all(a["mime_type"] == "image/jpeg" and a["image_data_url"].startswith("data:image/jpeg;base64,") and a["knowledge_components"] for a in d["assets"])'
test "$(status -b "$student_cookie" "$API/content/questions/Q_SIN_011/review")" = 403
student "$API/my-teacher" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["binding"] is None'

runs="$(teacher "$API/content/pipelines")"
read -r pipeline_id chapter_id ktq_ref er_ref < <(printf '%s' "$runs" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["runs"][0]; assert r["status"]=="review_ready" and r["stage"]=="review" and r["chapter_id"]; print(r["run_id"],r["chapter_id"],r["ktq_session_ref"],r["er_session_ref"])')
teacher "$API/review/tasks?queue=content&source_pipeline_id=$pipeline_id&limit=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["total_count"] == 114 and d["pending_count"] == 114 and d["resolved_count"] == 0 and d["rejected_count"] == 0'
test -n "$pipeline_id"
test -n "$chapter_id"
test -n "$ktq_ref"
test -n "$er_ref"
test "$ktq_ref" != "$er_ref"
teacher "$API/agent-sessions/$ktq_ref/events" | python3 -c 'import json,sys; d=json.load(sys.stdin); events=d.get("events",[]); turns=[e for e in events if e.get("type")=="turn_end" and e.get("usage")]; assert events and turns; assert all(all(k in e["usage"] for k in ("input","output","cacheRead","cacheWrite","total")) for e in turns)'
teacher "$API/agent-sessions/$er_ref/events" | python3 -c 'import json,sys; d=json.load(sys.stdin); events=d.get("events",[]); turns=[e for e in events if e.get("type")=="turn_end" and e.get("usage")]; assert events and turns; assert all(all(k in e["usage"] for k in ("input","output","cacheRead","cacheWrite","total")) for e in turns)'

# 浏览器不再暴露可绕过“上传后确认”的 OCR/KTQ/ER 直达入口。
test "$(status -b "$teacher_cookie" -X POST "$API/content/documents/ocr")" = 404
test "$(status -b "$teacher_cookie" -X POST "$API/content/ktq/run")" = 404
test "$(status -b "$teacher_cookie" -X POST "$API/content/er/run")" = 404
test "$(status -b "$teacher_cookie" -X POST -H 'content-type: application/json' -d '{"files":[]}' "$API/content/pipelines")" = 422

for path in /login.html /content.html /agent-session.html /assets/app.css /assets/app-shell.js /assets/math-render.js /assets/math-render.css /fonts/lxgw-wenkai/lxgwwenkai-regular.css; do
  test "$(status "$BASE$path")" = 200
done
for port in 3001 3002 3003 3005; do
  test "$(status "http://127.0.0.1:$port/healthz")" = 200
done

# 用户界面、任务 Prompt 与可发现 Skills 使用产品语言；内部验收语境只留在设计资料中。
if rg -n '比赛|赛题|评委|竞赛|硬门槛' \
  "$repo_root/src/apps/web/public" "$repo_root/policies/tasks" "$repo_root/src/services/agent-runtime/skills" \
  --glob '!auth-client.js'; then
  printf '%s\n' 'product-facing evaluation language found' >&2
  exit 1
fi

printf '%s\n' 'CURRENT STATE SMOKE PASS'
