#!/bin/sh
# Idempotent migrator for the deliberately separate mathpilot_pi database.
# The first two files describe the pre-owner-only schema, so they must not be
# replayed after 0003/0004 have removed student_id.  We detect each boundary
# from PostgreSQL instead of relying on a second database or an application
# startup side effect.
set -eu

: "${PI_DATABASE_URL:?PI_DATABASE_URL required}"

MIGRATION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/migrations" && pwd)

has_table() {
  [ "$(psql "$PI_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "select to_regclass('public.$1') is not null")" = "t" ]
}

apply() {
  echo "apply $1"
  psql "$PI_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$MIGRATION_DIR/$1.sql"
}

# 0001 creates both the thread and ACL tables.  Never replay it once the
# thread table exists: its historical policies mention student_id.
if ! has_table pi_threads; then
  apply 0001_pi_threads
fi

# 0002 is similarly guarded because its historical RLS policy mentions the
# pre-migration card-event student_id column.
if ! has_table pi_card_events; then
  apply 0002_pi_card_events
fi

# These migrations are intentionally idempotent.  Re-running them also repairs
# policies after a manually restored development database; relying only on a
# column marker would leave a partially restored schema silently unprotected.
# 0003/0004/0005 each run in a transaction and use IF EXISTS/IF NOT EXISTS for
# structural changes, so this remains safe on every deploy.
apply 0003_pi_threads_user_owner
apply 0004_pi_card_events_actor
apply 0005_pi_attachments

echo "Pi schema is up to date"
