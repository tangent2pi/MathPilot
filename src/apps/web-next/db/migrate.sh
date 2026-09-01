#!/bin/sh
# Bootstrap the final schema for the deliberately separate mathpilot_pi
# database. Historical Pi schemas are intentionally unsupported; the schema
# file fails closed and asks operators to recreate this dedicated database.
set -eu

: "${PI_DATABASE_URL:?PI_DATABASE_URL required}"

MIGRATION_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/migrations" && pwd)

psql "$PI_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -f "$MIGRATION_DIR/0001_pi_session_schema.sql"

echo "Pi schema is up to date"
