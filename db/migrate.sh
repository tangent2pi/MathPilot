#!/bin/sh
# 幂等迁移 runner：按文件名顺序应用 db/migrations/*.sql，
# 已在 infra_schema_migration 登记的版本跳过。
set -eu
: "${DATABASE_URL:?DATABASE_URL required}"

for f in /migrations/*.sql; do
  v=$(basename "$f" .sql)
  has_table=$(psql "$DATABASE_URL" -tAc "select to_regclass('public.infra_schema_migration')")
  if [ "$has_table" = "infra_schema_migration" ]; then
    applied=$(psql "$DATABASE_URL" -tAc "select count(*) from infra_schema_migration where version = '$v'")
  else
    applied=0
  fi
  if [ "$applied" = "1" ]; then
    echo "skip  $v (already applied)"
  else
    echo "apply $v"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  fi
done
