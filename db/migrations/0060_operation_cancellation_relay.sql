-- 0060: expose active cancelled operations to learning-next so it can forward
-- the database command to the owning Temporal Workflow and Pi session.
begin;

create or replace function mathpilot_science_v3_pending_workflow_cancellations(
  p_limit integer default 32
) returns table(operation_id text, workflow_id text)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select operation.operation_id, attempt.workflow_id
    from public.science_v3_operation operation
    join public.science_v3_agent_attempt attempt
      on attempt.tenant_id=operation.tenant_id
     and attempt.operation_id=operation.operation_id
     and attempt.status='started'
   where operation.status='cancelled'
   order by operation.updated_at
   limit greatest(1,least(coalesce(p_limit,32),100))
$$;

revoke all on function mathpilot_science_v3_pending_workflow_cancellations(integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant execute on function mathpilot_science_v3_pending_workflow_cancellations(integer) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0060_operation_cancellation_relay');
commit;
