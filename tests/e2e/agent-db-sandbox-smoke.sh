#!/bin/sh
set -eu

# Run this script inside the agent-runtime container. It proves that the normal
# Bash sandbox reaches PostgreSQL only through the mounted Unix socket and that
# its derived identity can call safe read functions but cannot read tables.

workspace=${WORKSPACE_ROOT:-/var/lib/mathpilot/workspaces}/smoke-agent-db
install -d -o 65534 -g 65534 "$workspace/input" "$workspace/output" "$workspace/tmp"
test -S /var/run/mathpilot-db/.s.PGSQL.5432
test -n "${AGENT_DB_MASTER_SECRET:-}"

password_for() {
  printf '%s' "$AGENT_DB_MASTER_SECRET:$1" | sha256sum | cut -d' ' -f1
}

run_sandbox() {
  db_user=$1
  sql=$2
  credential_role=${3:-$db_user}
  db_password=$(password_for "$credential_role")
  setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs \
    /usr/bin/bwrap \
      --unshare-all --die-with-parent --new-session \
      --ro-bind /usr /usr \
      --ro-bind /bin /bin \
      --ro-bind /lib /lib \
      --ro-bind /lib64 /lib64 \
      --proc /proc --dev /dev --tmpfs /tmp \
      --ro-bind "$workspace" /workspace \
      --bind "$workspace/output" /workspace/output \
      --bind "$workspace/tmp" /workspace/tmp \
      --ro-bind /var/run/mathpilot-db /var/run/mathpilot-db \
      --chdir /workspace --clearenv \
      --setenv HOME /workspace/tmp \
      --setenv PATH /usr/local/bin:/usr/bin:/bin \
      --setenv PGHOST /var/run/mathpilot-db \
      --setenv PGPORT 5432 \
      --setenv PGDATABASE "${AGENT_DB_NAME:-mathpilot}" \
      --setenv PGUSER "$db_user" \
      --setenv PGPASSWORD "$db_password" \
      --setenv PGOPTIONS '-c statement_timeout=15000 -c default_transaction_read_only=on' \
      /usr/bin/psql -X -v ON_ERROR_STOP=1 -Atqc "$sql"
}

content_role=mathpilot_agent_content_tnt_dev00001
student_role=mathpilot_agent_tnt_dev00001_usr_student01

content_result=$(run_sandbox "$content_role" \
  "select session_user, jsonb_typeof(mathpilot_agent_library('questions', '', 10, 0));")
test "$content_result" = "$content_role|object"

if run_sandbox "$content_role" 'select count(*) from content_question;' >/dev/null 2>&1; then
  echo 'direct table access unexpectedly succeeded' >&2
  exit 1
fi

content_student=$(run_sandbox "$content_role" \
  "select mathpilot_agent_student_context('usr_student01') = '{}'::jsonb;")
test "$content_student" = t

own_student=$(run_sandbox "$student_role" \
  "select mathpilot_agent_student_context('usr_student01')->'scope'->>'subject_id';")
test "$own_student" = usr_student01

other_student=$(run_sandbox "$student_role" \
  "select mathpilot_agent_student_context('usr_student02') = '{}'::jsonb;")
test "$other_student" = t

if run_sandbox mathpilot_agent_tnt_dev00001_usr_student02 'select 1;' "$student_role" >/dev/null 2>&1; then
  echo 'another student role accepted the wrong derived credential' >&2
  exit 1
fi

printf '%s\n' 'agent database sandbox: PASS'
