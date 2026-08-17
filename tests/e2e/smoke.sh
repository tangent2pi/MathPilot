#!/usr/bin/env bash
# 组合根 smoke：健康检查 + api→learning 建 Session→PG 回读 + fake Provider trace。
# 前置：deploy/dev 组合根已启动（docker compose up -d）。
set -euo pipefail

API=${API_URL:-http://localhost:3001}
TENANT=${TENANT_ID:-tnt_dev00001}

echo "== healthz =="
for url in \
  "$API/healthz" \
  "http://localhost:3002/healthz" \
  "http://localhost:3003/healthz" \
  "http://localhost:3004/healthz"; do
  curl -fsS "$url" | grep -q '"status":"ok"' && echo "OK  $url"
done

echo "== create session via api =="
created=$(curl -fsS -X POST "$API/api/sessions" \
  -H 'content-type: application/json' \
  -H "x-tenant-id: $TENANT" \
  -d '{"student_id":"usr_student01","question_id":"Q_TRI_012","chapter_package_version":"0.1.0","mode":"diagnostic","draft_enabled":false}')
echo "$created"
session_id=$(echo "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')

echo "== read back session =="
curl -fsS -H "x-tenant-id: $TENANT" "$API/api/sessions/$session_id" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"]=="CREATE" and d["mode"]=="diagnostic"; print("OK readback", d["session_id"])'

echo "== fake model provider =="
curl -fsS -X POST "http://localhost:3004/providers/model/generate" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"ping"}]}],"correlationId":"cor_smoke0001"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["trace"]["implementation"]=="fake.model"; print("OK fake trace", d["trace"]["traceId"])'

echo "== snapshot 404 + profile_lag（尚无快照属预期） =="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-tenant-id: $TENANT" "$API/api/snapshots/usr_student01")
[ "$code" = "404" ] && echo "OK snapshot 404 (profile_lag)"

echo "== submit 闭环：判答→观测→SER→TSS→SLR→Dream 入队 =="
submit=$(curl -fsS -X POST "$API/api/sessions/$session_id/submit" \
  -H 'content-type: application/json' \
  -H "x-tenant-id: $TENANT" \
  -d '{"answer_text":"由正弦定理得 sin B = √2/2，所以 B = 45° 或 135°（两解都成立）。"}')
echo "$submit" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["judgment"]["verdict"]=="correct", d["judgment"]
ser=d["scientific_evaluation_report"]
assert ser["calibration_status"]=="prior_only" and 0<ser["p_bkt_baseline"]<=1
assert d["dream_queued"] is True and d["session_learning_record_id"].startswith("slr_")
print("OK closed-loop", d["judgment"]["verdict"], "p_bkt=", ser["p_bkt_baseline"], "record=", d["session_learning_record_id"])
'

echo "== 重复提交已关闭 Session 必须 409 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/sessions/$session_id/submit" \
  -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"answer_text":"again"}')
[ "$code" = "409" ] && echo "OK resubmit blocked (409)"

obs1=$(echo "$submit" | python3 -c 'import json,sys; print(json.load(sys.stdin)["observation_id"])')

echo "== 第二题（同学生同维度）再观测一次 success =="
s2=$(curl -fsS -X POST "$API/api/sessions" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"student_id":"usr_student01","question_id":"Q_TRI_020","chapter_package_version":"0.1.0","mode":"diagnostic","draft_enabled":false}')
sid2=$(echo "$s2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
submit2=$(curl -fsS -X POST "$API/api/sessions/$sid2/submit" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"answer_text":"135° 也成立，两解。"}')
obs2=$(echo "$submit2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["observation_id"])')
echo "OK second observation $obs2"

echo "== Dream 消费 SLR → Validator → 快照 =="
dream=$(curl -fsS -X POST "$API/api/dream/run" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"student_id":"usr_student01"}')
echo "$dream" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["validation"]["result"]=="passed"
dim=d["dimensions"][0]
assert dim["dimension_id"]=="K_SSA" and dim["state"]=="possibly_mastered", dim
print("OK dream", d["decision_id"], "p_profile=", dim["p_profile"], "state=", dim["state"])
'

echo "== 快照可查 =="
curl -fsS -H "x-tenant-id: $TENANT" "$API/api/snapshots/usr_student01" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["source_decision_id"].startswith("pud_")
print("OK snapshot", d["snapshot_id"])
'

echo "== Validator 负例：LR 越界必须退回 =="
curl -fsS -X POST "http://localhost:3003/dream/validate" -H 'content-type: application/json' -d '{
  "decision_id":"pud_evil0001","student_id":"usr_student01","prior_snapshot_id":null,
  "baseline_report_refs":["ser_nonexistent"],"teaching_summary_refs":["tss_nonexistent"],
  "dimension_updates":[{"dimension_id":"K_SSA","p_baseline":0.7,"p_final":0.5,"state_final":"mastered",
    "evidence_ledger":[{"code":"TRANSFER_SUCCESS_DISTINCT_CONTEXT","rubric_bin":"strong","lr_used":99.0,
      "session_refs":["s_onlyone01"],"evidence_refs":[],"explanation":"x"}],"uncertainty":"low"}],
  "semantic_profile_updates":[],"review_required":false,
  "model_id":"fake.dream","prompt_version":"x","skill_version":"y","created_at":"2026-08-17T00:00:00Z"
}' | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["result"]=="returned_to_model", d
failed={c["check"] for c in d["checks"] if not c["passed"]}
assert {"refs_exist_and_authorized","lr_within_allowed_range","arithmetic_recomputable","min_two_sessions_per_numeric_update"} <= failed, failed
print("OK validator rejected bad PUD:", sorted(failed))
'

echo "== 教师纠正：第二观测 supersede 为 failure 并重放 =="
pbefore=$(echo "$dream" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dimensions"][0]["p_profile"])')
old_pud=$(echo "$dream" | python3 -c 'import json,sys; print(json.load(sys.stdin)["decision_id"])')
old_snap=$(echo "$dream" | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot_id"])')
corr=$(curl -fsS -X POST "$API/api/review/corrections" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"target_id\":\"$obs2\",\"replacement_outcome\":\"failure\",\"reason\":\"学生第二题实际遗漏补角检验\",\"reviewer_id\":\"usr_teacher01\"}")
echo "$corr" | python3 -c "
import json,sys
d=json.load(sys.stdin)
p=d['replay_report']['p_bkt_baseline']
assert p < float('$pbefore'), f'replay should drop below {pbefore}, got {p}'
assert d['revision_record'] and d['revision_record']['slr_id'].startswith('slr_'), d.get('revision_record')
print('OK correction replayed, baseline', '$pbefore', '->', p, '| revision', d['revision_record']['slr_id'])
"
preplay=$(echo "$corr" | python3 -c 'import json,sys; print(json.load(sys.stdin)["replay_report"]["p_bkt_baseline"])')

echo "== 重复纠正同一观测必须 409 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/review/corrections" \
  -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d "{\"target_id\":\"$obs2\",\"replacement_outcome\":\"success\",\"reason\":\"dup\",\"reviewer_id\":\"usr_teacher01\"}")
[ "$code" = "409" ] && echo "OK duplicate correction blocked (409)"

echo "== 纠正后 Dream：消费修订 SLR，新 Decision/快照 supersede 旧版本 =="
dream2=$(curl -fsS -X POST "$API/api/dream/run" -H 'content-type: application/json' -H "x-tenant-id: $TENANT" \
  -d '{"student_id":"usr_student01"}')
echo "$dream2" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d.get('status') != 'no_pending_records', '纠正必须重新入 Dream 队列'
assert d['validation']['result']=='passed'
assert d['consumed_records'] >= 1
assert d['supersedes_decision'] == '$old_pud', (d['supersedes_decision'], '$old_pud')
assert d['supersedes_snapshot'] == '$old_snap', (d['supersedes_snapshot'], '$old_snap')
dim = next(x for x in d['dimensions'] if x['dimension_id']=='K_SSA')
assert abs(dim['p_profile'] - float('$preplay')) < 1e-9, (dim['p_profile'], '$preplay')
print('OK dream supersede chain:', '$old_pud', '->', d['decision_id'], '| p_profile', dim['p_profile'], 'state', dim['state'])
"

echo "== 旧快照保留（supersede 不覆盖历史）=="
curl -fsS -H "x-tenant-id: $TENANT" "$API/api/snapshots/usr_student01" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['supersedes'] == '$old_snap'
print('OK snapshot chain', d['snapshot_id'], 'supersedes', d['supersedes'])
"

# ────────────────────────────────────────────────────────
# WP-03: OIDC 鉴权（真实 Keycloak token）
# ────────────────────────────────────────────────────────
KC=${KEYCLOAK_URL:-http://localhost:8080}

get_token() {
  local user="$1" i tok
  for i in $(seq 1 30); do
    tok=$(curl -s -X POST "$KC/realms/agmath/protocol/openid-connect/token" \
      -d "client_id=agmath-dev-cli" -d "grant_type=password" \
      -d "username=$user" -d "password=dev-only" 2>/dev/null \
      | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")')
    if [ -n "$tok" ]; then echo "$tok"; return 0; fi
    sleep 5
  done
  echo "FATAL: cannot obtain token for $user" >&2
  return 1
}

echo "== OIDC：获取 token（等待 Keycloak 就绪）=="
STOK=$(get_token student.dev)
TTOK=$(get_token teacher.dev)
echo "OK tokens acquired"

echo "== OIDC：/api/me 映射（JIT 领域用户）=="
curl -fsS -H "authorization: Bearer $STOK" "$API/api/me" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["via"]=="oidc" and "student" in d["roles"] and d["user_id"].startswith("usr_")
assert d["tenant_id"]=="tnt_dev00001"
print("OK oidc principal", d["user_id"], d["roles"])
'

echo "== OIDC：学生自域强制（伪造 student_id 与 x-tenant-id 均被覆盖）=="
curl -fsS -X POST "$API/api/sessions" \
  -H "authorization: Bearer $STOK" \
  -H "x-tenant-id: tnt_evil0000" \
  -H 'content-type: application/json' \
  -d '{"student_id":"usr_teacher01","question_id":"Q_TRI_012","chapter_package_version":"0.1.0","mode":"diagnostic","draft_enabled":false}' \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["tenant_id"]=="tnt_dev00001", d["tenant_id"]
assert d["student_id"]!="usr_teacher01" and d["student_id"].startswith("usr_")
print("OK self-scope enforced: student_id ->", d["student_id"], "tenant ->", d["tenant_id"])
'

echo "== OIDC：伪造 token 必须 401 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer bogus.token.value" "$API/api/me")
[ "$code" = "401" ] && echo "OK invalid token rejected (401)"

echo "== OIDC：学生调教师端点必须 403 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/review/corrections" \
  -H "authorization: Bearer $STOK" -H 'content-type: application/json' \
  -d '{"target_id":"obs_x","replacement_outcome":"failure","reason":"x","reviewer_id":"usr_x"}')
[ "$code" = "403" ] && echo "OK student blocked from corrections (403)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/content/documents" \
  -H "authorization: Bearer $STOK" -H 'content-type: application/json' -d '{}')
[ "$code" = "403" ] && echo "OK student blocked from content pipeline (403)"

# ────────────────────────────────────────────────────────
# WP-06: 内容管线（教师 token）：上传 → KTQ → ER → 复核门 → 发布 → 血缘追溯
# ────────────────────────────────────────────────────────
echo "== 内容管线：登记文档与片段 =="
DOC_HASH=$(python3 -c "import hashlib,time; print('sha256:'+hashlib.sha256(str(time.time()).encode()).hexdigest())")
doc=$(curl -fsS -X POST "$API/api/content/documents" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d "{\"kind\":\"exercise_set\",\"original_hash\":\"$DOC_HASH\",\"storage_ref\":\"dev/upload/tri-set-1.pdf\",\"fragments\":[{\"page_no\":3,\"fragment_type\":\"question_box\",\"text_markdown\":\"在△ABC中，已知 a=2，b=√2，A=30°，求角 B。\",\"bbox\":[0.12,0.34,0.76,0.18]}]}")
doc_id=$(echo "$doc" | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')
echo "OK document $doc_id"

echo "== 内容管线：KTQ 独立抽取 run（staging + 复核任务）=="
ktq=$(curl -fsS -X POST "$API/api/content/ktq/run" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d "{\"document_id\":\"$doc_id\",\"chapter_id\":\"chap_triangle\"}")
qid=$(echo "$ktq" | python3 -c 'import json,sys; print(json.load(sys.stdin)["staged"][0]["question_id"])')
task=$(echo "$ktq" | python3 -c 'import json,sys; print(json.load(sys.stdin)["staged"][0]["review_task_id"])')
echo "OK ktq staged $qid, review task $task"

echo "== 内容管线：ER 独立调研 run =="
curl -fsS -X POST "$API/api/content/er/run" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d '{"chapter_id":"chap_triangle"}' | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["agent_run_id"].startswith("run_er_") and len(d["error_causes"])>=1
print("OK er run", d["agent_run_id"], d["error_causes"])
'

echo "== 内容管线：复核未裁决时发布必须 422 =="
PKG_VERSION="0.1.$(date +%s)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/content/publish" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d "{\"chapter_id\":\"chap_triangle\",\"version\":\"$PKG_VERSION\"}")
[ "$code" = "422" ] && echo "OK publish gated by pending review (422)"

echo "== 内容管线：教师确认复核任务 =="
curl -fsS -X PATCH "$API/api/review/tasks/$task" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d '{"status":"confirmed"}' | python3 -c '
import json,sys; d=json.load(sys.stdin)
assert d["status"]=="confirmed"; print("OK task confirmed", d["task_id"])
'

echo "== 内容管线：发布不可变章节包 =="
pub=$(curl -fsS -X POST "$API/api/content/publish" \
  -H "authorization: Bearer $TTOK" -H 'content-type: application/json' \
  -d "{\"chapter_id\":\"chap_triangle\",\"version\":\"$PKG_VERSION\"}")
echo "$pub" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert d["validation_report"]["passed"] and d["manifest_hash"].startswith("sha256:")
print("OK published", d["package_id"], d["version"], "questions:", d["questions"])
'

echo "== 内容管线：已发布题可读 =="
curl -fsS -H "authorization: Bearer $TTOK" "$API/api/content/questions/$qid" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert len(d["measurement_targets"])>=1 and len(d["provenance"])>=1
print("OK question readable", d["question_id"])
'

echo "== 验收：任一字段可追溯（片段/页码 + Agent Run/模型/Prompt + 审核决定）=="
curl -fsS -H "authorization: Bearer $TTOK" "$API/api/content/questions/$qid/lineage" | python3 -c '
import json,sys
d=json.load(sys.stdin)
rows=d["lineage"]
stem=[r for r in rows if r["field_path"]=="/stem_markdown"]
mt=[r for r in rows if r["field_path"]=="/measurement_targets"]
pub=[r for r in rows if r["field_path"]=="/published"]
assert stem and stem[0]["source_fragment_id"] and stem[0]["page_no"]==3, stem
assert mt and mt[0]["agent_run_id"].startswith("run_ktq_") and mt[0]["model_id"]=="fake.ktq" and mt[0]["prompt_version"], mt
assert pub and pub[0]["reviewer_id"] and pub[0]["review_decision"]=="confirmed", pub
print("OK lineage traceable:", len(rows), "rows; stem<-fragment p.%d, targets<-%s, published<-%s(%s)" % (
  stem[0]["page_no"], mt[0]["agent_run_id"], pub[0]["reviewer_id"], pub[0]["review_decision"]))
'

echo "SMOKE PASS"
