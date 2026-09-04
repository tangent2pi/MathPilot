-- 0057: 前台流式展示投影增加 delta 类别（text / thinking / tool）。
-- 仍只是展示投影：权威事实是 canonical message + PostgreSQL，
-- thinking/工具动作不参与科学状态，也不进入 outbox。
begin;

alter table science_v3_foreground_live_delta
  add column kind text not null default 'text'
    check (kind in ('text','thinking','tool'));

insert into infra_schema_migration(version) values ('0057_foreground_live_delta_kind');
commit;
