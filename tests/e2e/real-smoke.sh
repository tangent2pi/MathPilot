#!/usr/bin/env bash
# 真实内容流水线验收（显式运行，可能产生模型与 OCR 费用）。
# Better Auth 教师登录 → 上传原件草稿 → 用户确认 → KTQ Pi Session
# → 独立 ER Pi Session → 复核状态。OCR 是否调用由 KTQ Agent 自主决定。
set -euo pipefail

API=${API_URL:-http://localhost:3001}
SOURCE=${SOURCE_PATH:-competition-info/高中数学知识掌握诊断与学习规划相关数据/解三角形体系【2026.3.17】/01解三角形的入门题型（学生版）.pdf}
TEACHER_EMAIL=${BETTER_AUTH_TEACHER_EMAIL:-teacher@mathpilot.local}
TEACHER_PASSWORD=${BETTER_AUTH_TEACHER_PASSWORD:-MathPilotTeacher123!}
[ -f "$SOURCE" ] || { echo "Source not found: $SOURCE" >&2; exit 1; }

COOKIE=$(mktemp /tmp/mathpilot-real-cookie.XXXXXX)
BODY=$(mktemp /tmp/mathpilot-real-body.XXXXXX)
trap 'rm -f "$COOKIE" "$BODY"' EXIT

curl -fsS --retry 3 -c "$COOKIE" -H 'origin: http://localhost:8080' \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$TEACHER_EMAIL\",\"password\":\"$TEACHER_PASSWORD\",\"rememberMe\":false}" \
  "$API/api/auth/sign-in/email" >/dev/null

python3 - "$SOURCE" > "$BODY" <<'PY'
import base64
import json
import mimetypes
import os
import sys

source = sys.argv[1]
raw = open(source, "rb").read()
json.dump({"files": [{
    "kind": "teaching_material",
    "filename": os.path.basename(source),
    "mime_type": mimetypes.guess_type(source)[0] or "application/octet-stream",
    "file_base64": base64.b64encode(raw).decode(),
}]}, sys.stdout)
PY

echo "== 上传原件，保持待确认 =="
draft=$(curl -fsS --retry 3 -X POST "$API/api/content/pipelines" -b "$COOKIE" \
  -H 'content-type: application/json' --data-binary @"$BODY" --max-time 120)
echo "$draft" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="draft" and d["stage"]=="upload" and d["document_ids"] and d["ktq_session_ref"]!=d["er_session_ref"], d; print("OK draft",d["run_id"])'
RUN_ID=$(echo "$draft" | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')

echo "== 用户确认，启动连续处理 =="
confirmed=$(curl -fsS --retry 3 -X POST "$API/api/content/pipelines/$RUN_ID/confirm" \
  -b "$COOKIE" --max-time 60)
echo "$confirmed" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"] in ("queued","running"), d; print("OK confirmed",d["status"])'

echo "== 等待 KTQ 与 ER 完成（最长 12 分钟）=="
status=""
for _ in $(seq 1 72); do
  run=$(curl -fsS --retry 3 "$API/api/content/pipelines/$RUN_ID" -b "$COOKIE")
  status=$(echo "$run" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  stage=$(echo "$run" | python3 -c 'import json,sys; print(json.load(sys.stdin)["stage"])')
  echo "  $status / $stage"
  case "$status" in
    review_ready) break ;;
    failed) echo "$run"; exit 1 ;;
  esac
  sleep 10
done
[ "$status" = "review_ready" ] || { echo "pipeline timeout" >&2; exit 1; }

KTQ_REF=$(echo "$run" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ktq_session_ref"])')
ER_REF=$(echo "$run" | python3 -c 'import json,sys; print(json.load(sys.stdin)["er_session_ref"])')
[ "$KTQ_REF" != "$ER_REF" ]

for ref in "$KTQ_REF" "$ER_REF"; do
  events=$(curl -fsS --retry 3 "$API/api/agent-sessions/$ref/events" -b "$COOKIE")
  echo "$events" | REF="$ref" python3 -c 'import json,os,sys; d=json.load(sys.stdin); ev=d.get("events",[]); ends=[x for x in ev if x.get("type")=="session_end"]; assert ev and ends and ends[-1].get("status")=="completed", (os.environ["REF"],ev[-3:]); assert not any(x.get("type")=="model_update" for x in ev); print("OK session",os.environ["REF"],"events",len(ev))'
done

echo "REAL CONTENT PIPELINE PASS"
