-- 0015: 可刷新恢复的内容工坊流水线；KTQ 与 ER 保持独立 Session
begin;

create table content_pipeline_run (
  run_id          text primary key,
  tenant_id       text not null references identity_tenant(tenant_id),
  created_by      text not null references identity_user(user_id),
  chapter_id      text not null,
  status          text not null check (status in ('queued','running','review_ready','failed')),
  stage           text not null check (stage in ('upload','ktq','er','review')),
  document_ids    jsonb not null,
  ktq_session_ref text not null unique,
  er_session_ref  text not null unique,
  payload         jsonb not null default '{}'::jsonb,
  error_detail    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index content_pipeline_run_tenant_created_idx on content_pipeline_run(tenant_id, created_at desc);
alter table content_pipeline_run enable row level security;
create policy tenant_isolation on content_pipeline_run
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

insert into infra_schema_migration(version) values ('0015_content_pipeline_run');
commit;
