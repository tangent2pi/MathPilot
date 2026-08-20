-- 0029: 内容任务卡按用户关闭；只隐藏列表项，不删除流水线或产物。
begin;

create table content_pipeline_card_dismissal (
  tenant_id    text not null references identity_tenant(tenant_id),
  run_id       text not null references content_pipeline_run(run_id) on delete cascade,
  user_id      text not null references identity_user(user_id),
  dismissed_at timestamptz not null default now(),
  primary key (tenant_id, run_id, user_id)
);

create index content_pipeline_card_dismissal_user_idx
  on content_pipeline_card_dismissal(tenant_id, user_id, dismissed_at desc);

alter table content_pipeline_card_dismissal enable row level security;
create policy tenant_isolation on content_pipeline_card_dismissal
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

grant select, insert, update, delete on content_pipeline_card_dismissal to mathpilot_app;

insert into infra_schema_migration(version) values ('0029_content_pipeline_card_dismissal');
commit;
