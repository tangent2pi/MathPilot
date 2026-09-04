-- 0042: make AgentAttempt identity explicit for foreground Pi sessions.
--
-- Temporal activities retain their existing execution identity and uniqueness
-- constraints. Interactive Pi turns use a separate driver id and do not
-- manufacture workflow/activity ids merely to satisfy the old shape.
begin;

alter table science_v3_agent_attempt
  add column execution_driver text not null default 'temporal_activity'
    check (execution_driver in ('temporal_activity','interactive_epoch')),
  add column driver_execution_id text;

-- 0040 protects the attempt identity with a column allowlist.  The backfill is
-- the only point at which an existing attempt may acquire the new driver
-- identity, so remove and restore that guard inside this transaction.  The
-- preceding ALTER holds the table lock until commit and a failure restores the
-- old trigger together with the old schema.
drop trigger science_v3_agent_attempt_guard on science_v3_agent_attempt;

update science_v3_agent_attempt
   set driver_execution_id = 'temporal-attempt:' || agent_attempt_id
 where driver_execution_id is null;

create trigger science_v3_agent_attempt_guard before update on science_v3_agent_attempt
  for each row execute function forbid_mutation_except(
    'status', 'output_ref', 'resolved_model_id', 'input_tokens', 'output_tokens',
    'error_code', 'error_detail', 'completed_at', 'workspace_manifest'
  );

alter table science_v3_agent_attempt
  alter column driver_execution_id set not null,
  alter column workflow_id drop not null,
  alter column workflow_run_id drop not null,
  alter column temporal_activity_id drop not null,
  alter column temporal_attempt drop not null;

alter table science_v3_agent_attempt
  add constraint science_v3_agent_attempt_driver_execution_check
  check (driver_execution_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,254}$'),
  add constraint science_v3_agent_attempt_driver_shape_check
  check (
    (execution_driver='temporal_activity'
      and workflow_id is not null and workflow_run_id is not null
      and temporal_activity_id is not null and temporal_attempt is not null
      and temporal_attempt > 0)
    or
    (execution_driver='interactive_epoch'
      and workflow_id is null and workflow_run_id is null
      and temporal_activity_id is null and temporal_attempt is null)
  );

create unique index science_v3_agent_attempt_driver_execution_uidx
  on science_v3_agent_attempt (tenant_id, operation_id, execution_driver, driver_execution_id);

comment on column science_v3_agent_attempt.execution_driver is
  'The durable execution owner: Temporal activity or an active Pi Interactive Epoch.';
comment on column science_v3_agent_attempt.driver_execution_id is
  'Stable id supplied by the execution driver; unique within tenant, operation and driver.';

-- A published foreground event may already have been handed to the legacy
-- Temporal worker. Never let this migration silently race that execution with
-- Interactive Epoch: stop/drain the old relay and workers, then retry.
do $$
begin
  if exists (
    select 1
      from public.infra_outbox outbox
      join public.science_v3_foreground_request request
        on request.tenant_id=outbox.tenant_id
       and request.operation_id=outbox.operation_id
     where outbox.event_type='foreground.message_submitted'
       and (outbox.published_at is not null or outbox.workflow_id is not null)
       and request.status in ('queued','running')
  ) then
    raise exception '0042 cannot upgrade while a published foreground event has an active legacy Temporal execution; stop and drain the old foreground relay/workers, then retry';
  end if;
end
$$;

-- A Thread has one active foreground turn. Do not silently choose a winner if
-- a pre-0042 deployment left duplicate queued/running requests: fail the
-- migration and remediate those requests before enabling the new admission.
do $$
begin
  if exists (
    select 1
      from science_v3_foreground_request
     where status in ('queued','running')
     group by tenant_id,conversation_thread_id
    having count(*) > 1
  ) then
    raise exception '0042 cannot install the single-active foreground invariant: duplicate queued/running requests exist';
  end if;
end
$$;

create unique index science_v3_foreground_request_active_thread_uidx
  on science_v3_foreground_request(tenant_id,conversation_thread_id)
  where status in ('queued','running');

-- Interactive foreground admissions claim their outbox row atomically in API
-- admission.  The relay must not publish a second Temporal start for them.
drop index if exists infra_outbox_science_v3_pending_idx;
create index infra_outbox_science_v3_pending_idx
  on infra_outbox(occurred_at,event_id)
  where published_at is null and event_type in (
    'question.cut_requested','selection.intent_revised','question.closed',
    'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
  );

create or replace function mathpilot_science_v3_pending_workflow_starts(p_limit integer default 32)
returns table (
  event_id text,tenant_id text,operation_id text,event_type text,
  aggregate_ref text,aggregate_version bigint,payload_ref text,
  occurred_at timestamptz,delivery_attempts integer
)
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  if p_limit<1 or p_limit>100 then raise exception 'p_limit must be between 1 and 100'; end if;
  return query
    select o.event_id,o.tenant_id,o.operation_id,o.event_type,
           o.aggregate_type || ':' || o.aggregate_id,o.aggregate_version,
           o.payload_ref,o.occurred_at,o.delivery_attempts
      from public.infra_outbox o
     where o.published_at is null
       and o.event_type in (
         'question.cut_requested','selection.intent_revised','question.closed',
         'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
       )
     order by o.occurred_at,o.event_id limit p_limit;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_started(
  p_event_id text,p_workflow_id text,p_task_queue text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public
as $$
declare
  target public.infra_outbox%rowtype;
  expected_workflow_id text;
  existing public.science_v3_workflow_correlation%rowtype;
begin
  if p_task_queue!~'^[a-z][a-z0-9_-]{1,119}$' then raise exception 'invalid task queue'; end if;
  select * into target from public.infra_outbox o
   where o.event_id=p_event_id and o.event_type in (
     'question.cut_requested','selection.intent_revised','question.closed',
     'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
   );
  if not found then return false; end if;
  if target.event_type='selection.intent_revised' and target.aggregate_type='conversation-thread' then
    expected_workflow_id:='select-question:' || target.tenant_id || ':' || target.aggregate_id;
  else
    expected_workflow_id:=target.event_type || ':' || target.event_id;
  end if;
  if p_workflow_id<>expected_workflow_id then raise exception 'workflow ID must be %',expected_workflow_id; end if;
  insert into public.science_v3_workflow_correlation(
    event_id,tenant_id,operation_id,workflow_id,aggregate_ref,aggregate_version,task_queue
  ) values (
    target.event_id,target.tenant_id,target.operation_id,p_workflow_id,
    target.aggregate_type || ':' || target.aggregate_id,target.aggregate_version,p_task_queue
  ) on conflict(event_id) do nothing;
  select * into existing from public.science_v3_workflow_correlation where event_id=p_event_id;
  if existing.workflow_id<>p_workflow_id or existing.task_queue<>p_task_queue then
    raise exception 'event already correlated to a different Workflow';
  end if;
  update public.infra_outbox o
     set published_at=coalesce(o.published_at,now()),workflow_id=p_workflow_id,
         delivery_attempts=case when o.published_at is null then o.delivery_attempts+1 else o.delivery_attempts end,
         last_delivery_attempt_at=case when o.published_at is null then now() else o.last_delivery_attempt_at end,
         last_delivery_error=null
   where o.event_id=p_event_id;
  return true;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_start_failed(
  p_event_id text,p_error text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public
as $$
begin
  update public.infra_outbox o
     set delivery_attempts=o.delivery_attempts+1,last_delivery_attempt_at=now(),
         last_delivery_error=left(coalesce(p_error,'unknown error'),1000)
   where o.event_id=p_event_id and o.published_at is null
     and o.event_type in (
       'question.cut_requested','selection.intent_revised','question.closed',
       'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
     );
  return found;
end
$$;

insert into infra_schema_migration(version) values ('0042_science_v3_interactive_epoch');
commit;
