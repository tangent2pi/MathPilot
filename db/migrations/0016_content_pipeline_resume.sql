-- 0016: 允许 content 服务在进程重启后恢复所有租户的未完成流水线。
-- 普通业务查询仍受 RLS 约束；跨租户扫描只通过此无参数、只读的服务函数开放。
begin;

create or replace function mathpilot_pending_content_pipelines()
returns table (
  run_id text,
  tenant_id text,
  created_by text,
  chapter_id text,
  document_ids jsonb,
  ktq_session_ref text,
  er_session_ref text,
  stage text
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select p.run_id, p.tenant_id, p.created_by, p.chapter_id, p.document_ids,
         p.ktq_session_ref, p.er_session_ref, p.stage
    from public.content_pipeline_run p
   where p.status in ('queued', 'running')
   order by p.created_at
$$;

revoke all on function mathpilot_pending_content_pipelines() from public;

insert into infra_schema_migration(version) values ('0016_content_pipeline_resume');
commit;
