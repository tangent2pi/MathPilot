# db/ — PostgreSQL 数据底座

PostgreSQL 是唯一运行时事实源。五份审核过的 `data/*.csv` 仅作为一次性官方初始内容输入，
由带 SHA-256/行数的 manifest 导入后不再参与运行时读取；其它 CSV/XLSX 仍是派生或 fixture。

## 迁移规范

- 迁移文件为纯 SQL，按 `NNNN_name.sql` 编号；Next 内容切换统一由
  `0031_content_pipeline_cutover.sql` 一次收敛，不重新引入废弃的六段纯增量迁移；
- 每个迁移以 `insert into infra_schema_migration` 结尾（0001 建表除外）；
- 所有业务表必须含 `tenant_id`，且在 `0006_outbox_rls.sql` 统一启用 RLS；
- 跨边界族（content/runtime/state/review）之间**不加外键**，一致性由应用层契约校验保证；同族内部允许外键；
- 不可变事件表（runtime 事件、state 决策、review 纠正）由 trigger 禁止 UPDATE/DELETE；纠正只能 supersede + 重放（ADR-004）；
- 契约对象主体以 `payload jsonb` 存储，查询字段提升为列；payload 必须符合 `src/packages/contracts/schemas/` 对应 schema。

## 应用账号（部署时创建，迁移不内建）

| 账号 | 用途 | 权限 |
|---|---|---|
| `mathpilot_migrate` | 执行迁移 | DDL |
| `mathpilot_app` | 业务读写 | DML，受 RLS 约束 |
| `mathpilot_read` | 只读分析 | SELECT，受 RLS 约束 |

连接时 `set app.current_tenant = '<tenant_id>'` 以激活租户隔离。

## 表族

- `identity_*`：租户、用户、班级（OIDC sub 映射）
- `content_*`：文档、片段、K/T/E/Q/R、measurement_target、field_lineage、chapter_package
- `runtime_*`：assessment_run、question_session、attempt、观测、Artifact、双产物
- `state_*`：SER、EvidenceBundle、PUD、掌握/保持/错因状态、快照、计划
- `review_*`：复核任务、教师纠正、发布记录、评测、agent_trace
- `infra_outbox`：事务性发件箱

## Next 内容切换

- 正式 schema：`migrations/0031_content_pipeline_cutover.sql`。
- 官方清单：`migration-data/official-content-manifest.csv`，固定 174 项，不含学生案例。
- 导入：先运行 `pnpm --dir src/services/content-next run migrate:official -- --report=/tmp/report.json`，
  审核后追加 `--execute`。
- 误执行的空增量对象和最终旧表清理由 `cutover/README.md` 中的受保护手工脚本处理；自动
  runner 不做猜测性删除。
