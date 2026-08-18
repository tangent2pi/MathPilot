#!/usr/bin/env bash
# 端到端（前置：.env 配 MODEL_API_KEY + OCR_API_TOKEN；模型调用统一经 agent-runtime/Pi）：
#   1) Teaching Agent 模型主判（经 Pi Session；正例 correct / 负例 partially|incorrect）
#   2) PaddleOCR 官方 API 解析赛题 PDF → 题框片段
#   3) KTQ 抽取 Agent（经 Pi，独立 Session）→ staging + 血缘
#   4) ER 调研 Agent（经 Pi，独立 Session）→ 错因/规则
# 429 由调用层重试；本脚本对网络瞬断加 curl --retry。
set -euo pipefail

API=${API_URL:-http://localhost:3001}
TENANT=${TENANT_ID:-tnt_dev00001}
PDF=${PDF_PATH:-competition-info/高中数学知识掌握诊断与学习规划相关数据/解三角形体系【2026.3.17】/01解三角形的入门题型（学生版）.pdf}
CHAPTER=${CHAPTER_ID:-chap_tri_real}
STUDENT=${STUDENT_ID:-usr_student01}
[ -f "$PDF" ] || { echo "PDF not found: $PDF" >&2; exit 1; }

# ── 1) 模型判答正例 ─────────────────────────────────────
# SKIP_JUDGE=1 可跳过（判答段已通过时节省模型调用）
if [ "${SKIP_JUDGE:-0}" != "1" ]; then
echo "== 模型判答：正确答案（两解齐全）=="
sid=$(curl -fsS --retry 3 -X POST "$API/api/sessions" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"student_id\":\"$STUDENT\",\"question_id\":\"Q_TRI_012\",\"chapter_package_version\":\"0.1.0\",\"mode\":\"diagnostic\",\"draft_enabled\":false}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
echo "session $sid"
submit=$(curl -fsS --retry 3 -X POST "$API/api/sessions/$sid/submit" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"answer_text":"由正弦定理 a/sinA = b/sinB，sinB = b·sinA/a = 2×0.5/√3 = 1/√3 ≈ 0.5774，故 B ≈ 35.3° 或 144.7°。两者均满足 A+B<180° 且 b·sinA < a < b，两解都成立。"}' \
  --max-time 420)
echo "$submit" | python3 -c '
import json,sys
d=json.load(sys.stdin)
j=d["judgment"]
assert j["verdict"]=="correct", ("verdict", j["verdict"], j["decision_summary"])
assert len(j["rubric_items"])>=2, j["rubric_items"]
assert "scnet" in j["model_id"], j["model_id"]
print("OK  model grade correct |", j["model_id"], "| rubric", [(r["id"], r["status"]) for r in j["rubric_items"]])
print("     ", j["decision_summary"][:80])
'

# ── 2) 模型判答负例（只给锐角解，缺补角分支） ───────────
echo "== 模型判答：缺补角分支（应非 correct）=="
sid2=$(curl -fsS --retry 3 -X POST "$API/api/sessions" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"student_id\":\"$STUDENT\",\"question_id\":\"Q_TRI_012\",\"chapter_package_version\":\"0.1.0\",\"mode\":\"diagnostic\",\"draft_enabled\":false}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
submit2=$(curl -fsS --retry 3 -X POST "$API/api/sessions/$sid2/submit" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"answer_text":"由正弦定理 sinB = 1/√3 ≈ 0.5774，因为 0<B<180° 且 A=30°，B 为锐角，所以 B ≈ 35.3°。"}' \
  --max-time 420)
echo "$submit2" | python3 -c '
import json,sys
d=json.load(sys.stdin)
j=d["judgment"]
assert j["verdict"] in ("partially_correct","incorrect"), ("verdict", j["verdict"], j["decision_summary"])
ssa=[r for r in j["rubric_items"] if "branch" in r["id"] or "补角" in r["id"]]
print("OK  model grade rejects missing branch |", j["verdict"], "| rubric", [(r["id"], r["status"]) for r in j["rubric_items"]])
'
fi  # SKIP_JUDGE

# ── 3) 真实 OCR ─────────────────────────────────────────
echo "== OCR：赛题 PDF 第 1 页（PaddleOCR-VL-1.6）=="
# base64 经文件传 body（命令行参数有 ARG_MAX 上限，大 PDF 会 E2BIG）
# 第 1 页为"课程把控"概述页（无题）；题型归纳/习题巩固在中部 → 默认 1-12 页
python3 - "$PDF" <<'PY'
import json, sys, os, base64
raw = open(sys.argv[1], "rb").read()
body = {
  "kind": "exercise_set",
  "file_base64": base64.b64encode(raw).decode(),
  "filename": "tri-01.pdf",
  "mime_type": "application/pdf",
  "page_ranges": os.environ.get("OCR_PAGES", "2-4"),
  "page_start": 1,
}
json.dump(body, open("/tmp/ocr-body.json", "w"))
PY
doc=$(curl -sS --retry 3 -X POST "$API/api/content/documents/ocr" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  --data-binary @/tmp/ocr-body.json --max-time 420)
echo "$doc" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d.get("document_id"), d
if d.get("error") == "duplicate document":
    print("NOTE duplicate document reused:", d["document_id"], "（此前已入库，跳过题框断言）")
else:
    assert "aistudio" in (d.get("ocr_implementation") or ""), d.get("ocr_implementation")
    assert (d.get("question_box_count") or 0) >= 1, d
    print("OK  ocr", d["ocr_implementation"], "| fragments", len(d.get("fragments") or []), "| question boxes", d["question_box_count"], "| doc", d["document_id"])
    print("     pages:", [(p["page_no"], p["markdown_chars"]) for p in d.get("pages") or []])
'
doc_id=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')

# ── 4) KTQ 真实抽取 ─────────────────────────────────────
echo "== KTQ 抽取（主模型，独立 run）=="
ktq=$(curl -fsS --retry 3 -X POST "$API/api/content/ktq/run" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"document_id\":\"$doc_id\",\"chapter_id\":\"$CHAPTER\"}" --max-time 420)
echo "$ktq" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert (d.get("staged") or []), d
assert "scnet" in (d.get("extractor") or ""), d.get("extractor")
assert all(s.get("review_task_id") for s in d["staged"]), d["staged"]
print("OK  ktq extractor", d["extractor"], "| staged", len(d["staged"]), "| run", d["agent_run_id"])
for s in d["staged"]: print("     ", s["question_id"], "task", s["review_task_id"])
'
QID=$(echo "$ktq" | python3 -c 'import json,sys; print(json.load(sys.stdin)["staged"][0]["question_id"])')

# ── 5) ER 真实调研 ──────────────────────────────────────
echo "== ER 调研（主模型，独立 run）=="
er=$(curl -fsS --retry 3 -X POST "$API/api/content/er/run" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"chapter_id\":\"$CHAPTER\"}" --max-time 420)
echo "$er" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert (d.get("error_causes") or []), d
assert "scnet" in (d.get("extractor") or ""), d.get("extractor")
print("OK  er extractor", d["extractor"], "| causes", d["error_causes"], "| rules", d.get("rules"))
'

# ── 6) 血缘追溯（真实抽取链） ───────────────────────────
echo "== 血缘：KTQ 抽取字段可追溯到模型 run =="
curl -fsS --retry 3 -H "x-tenant-id: $TENANT" "$API/api/content/questions/$QID/lineage" | python3 -c '
import json,sys
d=json.load(sys.stdin)
mt=[r for r in d["lineage"] if r["field_path"]=="/measurement_targets"]
assert mt and mt[0]["agent_run_id"].startswith("run_ktq_"), mt
assert "scnet" in (mt[0]["model_id"] or ""), mt[0]["model_id"]
assert mt[0]["prompt_version"]=="ktq-extract@0.4.0", mt[0]["prompt_version"]
print("OK  lineage", d["question_id"], "->", mt[0]["agent_run_id"], mt[0]["model_id"], mt[0]["prompt_version"])
'

echo "REAL SMOKE PASS"
