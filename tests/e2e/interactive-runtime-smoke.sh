#!/usr/bin/env bash
# Real foreground-runtime smoke test. This creates one canonical thread and
# performs one paid model call; run explicitly from the Nix development shell.
set -euo pipefail

base=${MATHPILOT_E2E_BASE_URL:-http://127.0.0.1:8080}
student_email=${BETTER_AUTH_STUDENT_EMAIL:-student@mathpilot.local}
student_password=${BETTER_AUTH_STUDENT_PASSWORD:-MathPilotStudent123!}
run_suffix="$(date +%s)-$(openssl rand -hex 5)"
create_key="e2e-create-${run_suffix}"
message_key="e2e-message-${run_suffix}"
cookie="$(mktemp /tmp/mathpilot-interactive-cookie.XXXXXX)"
auth_body="$(mktemp /tmp/mathpilot-interactive-auth.XXXXXX)"
create_body="$(mktemp /tmp/mathpilot-interactive-create.XXXXXX)"
send_body="$(mktemp /tmp/mathpilot-interactive-send.XXXXXX)"
response_body="$(mktemp /tmp/mathpilot-interactive-response.XXXXXX)"
messages_body="$(mktemp /tmp/mathpilot-interactive-messages.XXXXXX)"
events_file="/tmp/mathpilot-interactive-events-${run_suffix}.sse"
reconnect_file="/tmp/mathpilot-interactive-reconnect-${run_suffix}.sse"
events_error="/tmp/mathpilot-interactive-events-${run_suffix}.stderr"
sse_pid=""

cleanup() {
  if [[ -n "$sse_pid" ]]; then kill "$sse_pid" 2>/dev/null || true; fi
  rm -f "$cookie" "$auth_body" "$create_body" "$send_body" "$response_body" "$messages_body"
}
trap cleanup EXIT

chmod 600 "$cookie" "$auth_body" "$create_body" "$send_body" "$response_body" "$messages_body"
jq -n --arg email "$student_email" --arg password "$student_password" \
  '{email:$email,password:$password,rememberMe:false}' >"$auth_body"
login_status="$(curl -sS -o "$response_body" -w '%{http_code}' -c "$cookie" \
  -H 'origin: http://127.0.0.1:8080' -H 'content-type: application/json' \
  --data-binary @"$auth_body" --max-time 20 "$base/api/auth/sign-in/email")"
[[ "$login_status" == "200" ]] || { printf 'login_status=%s\n' "$login_status"; exit 1; }

jq -n --arg key "$create_key" --arg title "交互运行时生产验收 ${run_suffix}" \
  '{idempotency_key:$key,title:$title}' >"$create_body"
create_status="$(curl -sS -o "$response_body" -w '%{http_code}' -b "$cookie" \
  -H 'content-type: application/json' -H "Idempotency-Key: $create_key" \
  --data-binary @"$create_body" --max-time 20 "$base/api/learning/threads")"
[[ "$create_status" == "201" || "$create_status" == "200" ]] || {
  printf 'create_status=%s\n' "$create_status"; jq -c '{code,title,status}' "$response_body"; exit 1;
}
thread_id="$(jq -er '.thread.thread_id' "$response_body")"
thread_version="$(jq -er '.thread.version' "$response_body")"

# Subscribe before dispatch to exercise the first-open provision race.
timeout 150s curl -sS -N -b "$cookie" -H 'accept: text/event-stream' \
  --max-time 145 "$base/api/pi/threads/$thread_id/events" >"$events_file" 2>"$events_error" &
sse_pid=$!
for _ in $(seq 1 20); do
  [[ -s "$events_file" ]] && break
  sleep 0.25
done

requested_at="$(date --utc +%Y-%m-%dT%H:%M:%S.000Z)"
jq -n --arg key "$message_key" --argjson version "$thread_version" --arg at "$requested_at" \
  --arg prompt '请只用两句话解释为什么负数乘负数等于正数，并给出一个数轴直觉。' \
  '{idempotency_key:$key,expected_version:$version,requested_at:$at,input:{content:$prompt}}' >"$send_body"
send_status="$(curl -sS -o "$response_body" -w '%{http_code}' -b "$cookie" \
  -H 'content-type: application/json' -H "Idempotency-Key: $message_key" \
  --data-binary @"$send_body" --max-time 190 "$base/api/pi/threads/$thread_id/messages")"
[[ "$send_status" == "200" ]] || {
  printf 'thread_id=%s\nsend_status=%s\n' "$thread_id" "$send_status"
  jq -c '{code,title,status}' "$response_body"; exit 1;
}

terminal=""
assistant_count=0
for _ in $(seq 1 90); do
  read_status="$(curl -sS -o "$messages_body" -w '%{http_code}' -b "$cookie" \
    --max-time 15 "$base/api/learning/threads/$thread_id/messages")"
  [[ "$read_status" == "200" ]] || { sleep 2; continue; }
  assistant_count="$(jq '[.data.messages[] | select(.author_kind=="assistant" and .lifecycle=="committed")] | length' "$messages_body")"
  terminal="$(jq -r '[.data.operations[].status | select(.=="succeeded" or .=="failed" or .=="cancelled")] | last // empty' "$messages_body")"
  if [[ "$assistant_count" -ge 1 && "$terminal" == "succeeded" ]]; then break; fi
  if [[ "$terminal" == "failed" || "$terminal" == "cancelled" ]]; then break; fi
  sleep 2
done
[[ "$assistant_count" -ge 1 && "$terminal" == "succeeded" ]] || {
  printf 'thread_id=%s\nterminal=%s\nassistant_count=%s\n' "$thread_id" "$terminal" "$assistant_count"
  jq -c '{messages:(.data.messages|map({author_kind,lifecycle,parts:(.parts|map(.type))})),operations:(.data.operations|map({status,error_code}))}' "$messages_body"
  exit 1
}

kill "$sse_pid" 2>/dev/null || true
wait "$sse_pid" 2>/dev/null || true
sse_pid=""

snapshot_status="$(curl -sS -o "$response_body" -w '%{http_code}' -b "$cookie" \
  --max-time 20 "$base/api/pi/threads/$thread_id")"
[[ "$snapshot_status" == "200" ]] || { printf 'snapshot_status=%s\n' "$snapshot_status"; exit 1; }
snapshot_message_count="$(jq -er '.messages | length' "$response_body")"
thinking_level="$(jq -er '.metadata.config.thinkingLevel' "$response_body")"

# A completed reconnect must immediately receive a native snapshot. Timeout is
# expected because the SSE connection remains open after that snapshot.
timeout 6s curl -sS -N -b "$cookie" -H 'accept: text/event-stream' \
  -H 'Last-Event-ID: e2e-reconnect-check' --max-time 5 \
  "$base/api/pi/threads/$thread_id/events" >"$reconnect_file" 2>/dev/null || true

duplicate_status="$(curl -sS -o "$response_body" -w '%{http_code}' -b "$cookie" \
  -H 'content-type: application/json' -H "Idempotency-Key: $message_key" \
  --data-binary @"$send_body" --max-time 40 "$base/api/pi/threads/$thread_id/messages")"
duplicate_code="$(jq -r '.code // empty' "$response_body")"
[[ "$duplicate_status" == "409" && "$duplicate_code" == "interactive_attempt_succeeded" ]] || {
  printf 'duplicate_status=%s\nduplicate_code=%s\n' "$duplicate_status" "$duplicate_code"; exit 1;
}

event_data_count="$(grep -c '^data:' "$events_file" || true)"
event_types="$(sed -n 's/^data: *//p' "$events_file" | jq -Rr 'fromjson? | .type? // empty' | sort -u | paste -sd, -)"
reconnect_snapshot_count="$(sed -n 's/^data: *//p' "$reconnect_file" | jq -Rr 'fromjson? | select(.type?=="snapshot") | .type' | wc -l)"
canonical_roles="$(jq -r '[.data.messages[].author_kind] | join(",")' "$messages_body")"
canonical_count="$(jq '.data.messages | length' "$messages_body")"

printf 'login_status=%s\n' "$login_status"
printf 'create_status=%s\n' "$create_status"
printf 'thread_id=%s\n' "$thread_id"
printf 'initial_thread_version=%s\n' "$thread_version"
printf 'send_status=%s\n' "$send_status"
printf 'terminal=%s\n' "$terminal"
printf 'canonical_message_count=%s\n' "$canonical_count"
printf 'canonical_roles=%s\n' "$canonical_roles"
printf 'sse_data_count=%s\n' "$event_data_count"
printf 'sse_event_types=%s\n' "$event_types"
printf 'snapshot_status=%s\n' "$snapshot_status"
printf 'snapshot_message_count=%s\n' "$snapshot_message_count"
printf 'thinking_level=%s\n' "$thinking_level"
printf 'reconnect_snapshot_count=%s\n' "$reconnect_snapshot_count"
printf 'duplicate_status=%s\n' "$duplicate_status"
printf 'duplicate_code=%s\n' "$duplicate_code"
printf 'events_file=%s\n' "$events_file"
printf 'reconnect_file=%s\n' "$reconnect_file"
