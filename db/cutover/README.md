# MathPilot 内容切换清理

`db/migrations/0031_content_pipeline_cutover.sql` 是唯一正式的规范化内容切换迁移。此前误生成的六个纯增量迁移文件已从仓库移除，不要把它们重新放回自动 runner。

- `0000_cleanup_partial_content_migrations.sql`：只在数据库曾经执行过那六个文件、且规范化目标表仍为空时运行。它会清掉旧 marker 和空的临时对象；发现任何数据就停止，不会猜测性删除。
- `0037_remove_legacy_content_pipeline.sql`：新入口和官方清单导入验收后，由运维在停旧服务的维护窗口手工运行。它删除完整旧 payload/source 表，但不删除独立的 Next 规范化表。

数据库卷无法确认是否来自错误的增量迁移时，优先使用新的空卷重新跑 `db/migrations/*.sql`；不要用 `DROP SCHEMA` 或宽范围删除命令修复。

空残留清理必须在同一连接显式确认：

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "set mathpilot.confirm_partial_cleanup = 'true'" \
  -f db/cutover/0000_cleanup_partial_content_migrations.sql
```

正式清理旧入口前先确认 `pkg_official_home_v1` 已存在且含 174 个包项，再停旧服务并运行：

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "set mathpilot.allow_legacy_content_drop = 'true'" \
  -f db/cutover/0037_remove_legacy_content_pipeline.sql
```
