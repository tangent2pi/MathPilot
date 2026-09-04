-- 0056: 前台教学回复的流式展示投影。
--
-- 纪律（修订后的前台流式裁决）：增量只是展示投影，权威事实仍是
-- science_v3_canonical_message + PostgreSQL。增量不参与科学状态计算，
-- 断线恢复靠前端按 (operation_id, sequence) 去重 + 权威消息全量刷新兜底。
-- 行是瞬态数据：api-next 的事件轮询会周期性清掉 30 分钟前的行。
begin;

create table science_v3_foreground_live_delta (
  id           bigint generated always as identity primary key,
  tenant_id    text not null,
  operation_id text not null,
  sequence     integer not null,
  delta        text not null check (char_length(delta) between 1 and 8000),
  created_at   timestamptz not null default now()
);

create index science_v3_foreground_live_delta_tenant_cursor_idx
  on science_v3_foreground_live_delta(tenant_id, id);
alter table science_v3_foreground_live_delta
  add constraint science_v3_foreground_live_delta_sequence_unique
    unique(tenant_id, operation_id, sequence);

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant select,insert,delete on science_v3_foreground_live_delta to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0056_foreground_live_delta');
commit;
