-- Durable manual entry point for a student-scoped REM + Deep sweep.
begin;

alter table infra_outbox drop constraint if exists infra_outbox_science_v3_envelope_check;
alter table infra_outbox add constraint infra_outbox_science_v3_envelope_check check (
  event_type not in (
    'question.cut_requested','selection.intent_revised','question.closed',
    'dream.rem_requested','dream.deep_requested','dream.full_requested',
    'teacher.correction_recorded','foreground.message_submitted'
  ) or (
    aggregate_version>0
    and payload_ref~'^[a-z][a-z0-9+.-]*:[^[:space:]]+$'
    and operation_id~'^op_[A-Za-z0-9]{8,}$'
    and payload='{}'::jsonb
  )
);

drop index if exists infra_outbox_science_v3_pending_idx;
create index infra_outbox_science_v3_pending_idx on infra_outbox(occurred_at,event_id)
where published_at is null and event_type in (
  'question.cut_requested','selection.intent_revised','question.closed',
  'dream.rem_requested','dream.deep_requested','dream.full_requested',
  'teacher.correction_recorded','foreground.message_submitted'
);

create or replace function mathpilot_science_v3_pending_workflow_starts(p_limit integer default 32)
returns table (
  event_id text,tenant_id text,operation_id text,event_type text,
  aggregate_ref text,aggregate_version bigint,payload_ref text,
  occurred_at timestamptz,delivery_attempts integer
)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_limit<1 or p_limit>100 then raise exception 'p_limit must be between 1 and 100'; end if;
  return query
    select o.event_id,o.tenant_id,o.operation_id,o.event_type,
           o.aggregate_type || ':' || o.aggregate_id,o.aggregate_version,
           o.payload_ref,o.occurred_at,o.delivery_attempts
      from public.infra_outbox o
     where o.published_at is null and o.event_type in (
       'question.cut_requested','selection.intent_revised','question.closed',
       'dream.rem_requested','dream.deep_requested','dream.full_requested',
       'teacher.correction_recorded','foreground.message_submitted'
     )
     order by o.occurred_at,o.event_id limit p_limit;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_started(
  p_event_id text,p_workflow_id text,p_task_queue text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  target public.infra_outbox%rowtype;
  expected_workflow_id text;
  existing public.science_v3_workflow_correlation%rowtype;
begin
  if p_task_queue!~'^[a-z][a-z0-9_-]{1,119}$' then raise exception 'invalid task queue'; end if;
  select * into target from public.infra_outbox o
   where o.event_id=p_event_id and o.event_type in (
     'question.cut_requested','selection.intent_revised','question.closed',
     'dream.rem_requested','dream.deep_requested','dream.full_requested',
     'teacher.correction_recorded','foreground.message_submitted'
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

insert into infra_schema_migration(version) values ('0065_immediate_dream');
commit;
