#!/usr/bin/env bash
# 无模型/无 OCR：验证待确认资料集可以逐份追加和移除，并清理本脚本创建的精确测试对象。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${BASE:-http://localhost:8080}"
temporary="$(mktemp -d /tmp/mathpilot-draft-flow.XXXXXX)"
cookie="$temporary/teacher.cookie"
run_id="" doc_one="" doc_two="" tenant_id=""

cd "$ROOT/deploy/dev"
set -a
. ./.env
set +a

cleanup() {
  if [[ -n "$run_id" && -n "$tenant_id" ]]; then
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q \
      -v run_id="$run_id" -v tenant_id="$tenant_id" -v doc_one="$doc_one" -v doc_two="$doc_two" <<'SQL' >/dev/null || true
begin;
delete from content_pipeline_run where tenant_id=:'tenant_id' and run_id=:'run_id';
delete from content_source_document_grant where tenant_id=:'tenant_id' and document_id in (:'doc_one',:'doc_two');
delete from content_source_document where tenant_id=:'tenant_id' and document_id in (:'doc_one',:'doc_two');
commit;
SQL
    docker compose exec -T content sh -eu -c '
      tenant="$1"; shift
      case "$tenant" in (*[!A-Za-z0-9_-]*|"") exit 2;; esac
      for document in "$@"; do
        case "$document" in (doc_[A-Za-z0-9_-]*) target="/var/lib/mathpilot/content-artifacts/$tenant/$document";; ("") continue;; (*) exit 2;; esac
        [ ! -e "$target" ] || find "$target" -xdev -depth -delete
      done
    ' sh "$tenant_id" "$doc_one" "$doc_two" || true
  fi
  find "$temporary" -depth -delete
}
trap cleanup EXIT

curl -fsS -c "$cookie" -H "origin: $BASE" -H 'content-type: application/json' \
  -d "{\"email\":\"${BETTER_AUTH_TEACHER_EMAIL:-teacher@mathpilot.local}\",\"password\":\"${BETTER_AUTH_TEACHER_PASSWORD:-MathPilotTeacher123!}\",\"rememberMe\":false}" \
  "$BASE/api/auth/sign-in/email" >/dev/null
me="$(curl -fsS -b "$cookie" "$BASE/api/me")"
tenant_id="$(printf '%s' "$me" | jq -r .tenant_id)"
stamp="$(date +%s%N)"
first="$(printf 'draft-one-%s\n' "$stamp" | base64 -w0)"
second="$(printf 'draft-two-%s\n' "$stamp" | base64 -w0)"

created="$(curl -fsS -b "$cookie" -H 'content-type: application/json' \
  -d "{\"files\":[{\"filename\":\"draft-one-$stamp.txt\",\"mime_type\":\"text/plain\",\"kind\":\"teaching_material\",\"file_base64\":\"$first\"}]}" \
  "$BASE/api/content/pipelines")"
run_id="$(printf '%s' "$created" | jq -r .run_id)"
doc_one="$(printf '%s' "$created" | jq -r '.document_ids[0]')"

appended="$(curl -fsS -b "$cookie" -H 'content-type: application/json' \
  -d "{\"files\":[{\"filename\":\"draft-two-$stamp.txt\",\"mime_type\":\"text/plain\",\"kind\":\"teaching_material\",\"file_base64\":\"$second\"}]}" \
  "$BASE/api/content/pipelines/$run_id/files")"
doc_two="$(printf '%s' "$appended" | jq -r '.document_ids[1]')"
printf '%s' "$appended" | jq -e '.status=="draft" and (.document_ids|length)==2 and (.files|length)==2' >/dev/null

removed="$(curl -fsS -X DELETE -b "$cookie" "$BASE/api/content/pipelines/$run_id/files/$doc_one")"
printf '%s' "$removed" | jq -e --arg doc "$doc_two" '.status=="draft" and (.document_ids|length)==1 and .document_ids[0]==$doc' >/dev/null
retrieved="$(curl -fsS -b "$cookie" "$BASE/api/content/pipelines/$run_id")"
printf '%s' "$retrieved" | jq -e '.status=="draft" and (.document_ids|length)==1 and (.payload.files|length)==1' >/dev/null

printf '%s\n' 'DRAFT FILE EDIT FLOW PASS'
