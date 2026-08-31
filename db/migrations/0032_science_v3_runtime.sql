-- 0032: science-v3 durable runtime foundation.
--
-- This is the only Next learning runtime write path.  It deliberately does
-- not map or backfill legacy run/session/profile tables.  PostgreSQL owns
-- domain facts and idempotent operation results; Temporal owns retries,
-- timers, cancellation, child workflows and schedules.
begin;

create table science_v3_operation (
  operation_id             text primary key check (operation_id ~ '^op_[A-Za-z0-9]{8,}$'),
  tenant_id                text not null references identity_tenant(tenant_id),
  requested_by_user_id     text not null references identity_user(user_id),
  kind                     text not null check (kind in (
    'submit_attempt', 'finalize_question', 'select_question', 'start_review',
    'annotation_feedback', 'teacher_correction', 'dream'
  )),
  status                   text not null default 'accepted' check (status in (
    'accepted', 'running', 'succeeded', 'needs_input', 'failed', 'cancelled'
  )),
  user_message             text not null check (length(user_message) between 1 and 1000),
  related_resource_refs    text[] not null default '{}',
  retryable                boolean not null default false,
  started_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  version                  bigint not null default 1 check (version > 0),
  unique (tenant_id, operation_id),
  check (cardinality(related_resource_refs) <= 32)
);
create index science_v3_operation_requester_idx
  on science_v3_operation (tenant_id, requested_by_user_id, updated_at desc);
create index science_v3_operation_active_idx
  on science_v3_operation (tenant_id, updated_at)
  where status in ('accepted', 'running', 'needs_input');

create table science_v3_operation_result (
  tenant_id             text not null references identity_tenant(tenant_id),
  operation_id          text not null,
  idempotency_key       text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  result_status         text not null check (result_status in ('committed', 'rejected', 'already_committed')),
  aggregate_ref         text not null check (aggregate_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  aggregate_version     bigint not null check (aggregate_version > 0),
  result_resource_refs  text[] not null default '{}',
  rejection_code        text check (rejection_code in (
    'version_conflict', 'stale_intent', 'candidate_invalid',
    'permission_denied', 'closed', 'invalid_evidence'
  )),
  recorded_at           timestamptz not null default now(),
  primary key (operation_id, idempotency_key),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  check (cardinality(result_resource_refs) <= 32),
  check ((result_status = 'rejected') = (rejection_code is not null))
);

-- Extend the existing infrastructure outbox only with the reference-sized
-- envelope required by science-v3.  The JSON payload remains empty for these
-- events so private learning content never becomes Temporal history.
alter table infra_outbox
  add column aggregate_version bigint,
  add column payload_ref text,
  add column operation_id text,
  add column workflow_id text,
  add column delivery_attempts integer not null default 0,
  add column last_delivery_attempt_at timestamptz,
  add column last_delivery_error text,
  add constraint infra_outbox_science_v3_operation_fk
    foreign key (tenant_id, operation_id)
      references science_v3_operation(tenant_id, operation_id),
  add constraint infra_outbox_science_v3_envelope_check check (
    event_type not in (
      'question.cut_requested', 'selection.intent_revised', 'question.closed',
      'dream.rem_requested', 'dream.deep_requested', 'teacher.correction_recorded'
    ) or (
      aggregate_version > 0
      and payload_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'
      and operation_id ~ '^op_[A-Za-z0-9]{8,}$'
      and payload = '{}'::jsonb
    )
  ),
  add constraint infra_outbox_delivery_attempts_check check (delivery_attempts >= 0),
  add constraint infra_outbox_workflow_id_check check (
    workflow_id is null or workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,239}$'
  );
create unique index infra_outbox_tenant_event_uidx on infra_outbox (tenant_id, event_id);
create index infra_outbox_science_v3_pending_idx
  on infra_outbox (occurred_at, event_id)
  where published_at is null and event_type in (
    'question.cut_requested', 'selection.intent_revised', 'question.closed',
    'dream.rem_requested', 'dream.deep_requested', 'teacher.correction_recorded'
  );

alter table infra_outbox force row level security;

drop trigger outbox_guard on infra_outbox;
create trigger outbox_guard before update on infra_outbox
  for each row execute function forbid_mutation_except(
    'published_at', 'workflow_id', 'delivery_attempts',
    'last_delivery_attempt_at', 'last_delivery_error'
  );

create table science_v3_workflow_correlation (
  event_id          text primary key references infra_outbox(event_id),
  tenant_id         text not null references identity_tenant(tenant_id),
  operation_id      text not null,
  workflow_id       text not null unique check (workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,239}$'),
  aggregate_ref     text not null check (aggregate_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  aggregate_version bigint not null check (aggregate_version > 0),
  task_queue        text not null check (task_queue ~ '^[a-z][a-z0-9_-]{1,119}$'),
  created_at        timestamptz not null default now(),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  foreign key (tenant_id, event_id)
    references infra_outbox(tenant_id, event_id)
);
create index science_v3_workflow_operation_idx
  on science_v3_workflow_correlation (tenant_id, operation_id, created_at);

-- Frozen, bounded Activity inputs and structured Pi outputs live in
-- PostgreSQL and are referenced from Workflow history.  They are runtime
-- artifacts, not a second copy of scientific projections or source files.
create table science_v3_agent_artifact (
  artifact_id       text primary key check (artifact_id ~ '^art_[A-Za-z0-9]{8,}$'),
  tenant_id         text not null references identity_tenant(tenant_id),
  operation_id      text not null,
  artifact_kind     text not null check (artifact_kind in ('input_bundle', 'structured_output')),
  schema_uri        text not null check (schema_uri ~ '^https://schemas\.mathpilot\.dev/[^[:space:]]+$'),
  payload           jsonb not null,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz,
  unique (tenant_id, artifact_id),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  check (expires_at is null or expires_at > created_at)
);
create index science_v3_agent_artifact_operation_idx
  on science_v3_agent_artifact (tenant_id, operation_id, artifact_kind, created_at desc);

create table science_v3_agent_attempt (
  agent_attempt_id      text primary key check (agent_attempt_id ~ '^agt_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  operation_id          text not null,
  workflow_id           text not null check (workflow_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,239}$'),
  workflow_run_id       text not null check (length(workflow_run_id) between 1 and 255),
  temporal_activity_id  text not null check (length(temporal_activity_id) between 1 and 255),
  task_type              text not null check (task_type in (
    'grade', 'diagnose', 'teach_summary', 'select_question', 'light', 'rem',
    'deep', 'foreground_teaching', 'semantic_decomposition'
  )),
  task_spec_version      text not null check (task_spec_version ~ '^v[1-9][0-9]*(\.[0-9]+){0,2}$'),
  temporal_attempt       integer not null check (temporal_attempt > 0),
  status                 text not null default 'started' check (status in (
    'started', 'succeeded', 'failed', 'cancelled', 'timed_out'
  )),
  input_ref              text not null check (input_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  output_ref             text check (output_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  model_policy_id        text not null,
  resolved_model_id      text,
  prompt_version         text not null,
  skill_ref              text not null check (skill_ref ~ '^skill:[a-z0-9][a-z0-9_-]+@v[1-9][0-9]*(\.[0-9]+){0,2}$'),
  input_tokens           integer check (input_tokens >= 0),
  output_tokens          integer check (output_tokens >= 0),
  error_code             text,
  error_detail           text check (length(error_detail) <= 2000),
  started_at             timestamptz not null default now(),
  completed_at           timestamptz,
  unique (workflow_id, workflow_run_id, temporal_activity_id, temporal_attempt),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  check (
    (status = 'started' and completed_at is null)
    or (status <> 'started' and completed_at is not null)
  ),
  check (status <> 'succeeded' or output_ref is not null)
);
create index science_v3_agent_attempt_operation_idx
  on science_v3_agent_attempt (tenant_id, operation_id, started_at desc);

create or replace function science_v3_operation_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'science-v3 operation cannot be deleted';
  end if;
  if NEW.operation_id is distinct from OLD.operation_id
     or NEW.tenant_id is distinct from OLD.tenant_id
     or NEW.requested_by_user_id is distinct from OLD.requested_by_user_id
     or NEW.kind is distinct from OLD.kind
     or NEW.started_at is distinct from OLD.started_at then
    raise exception 'science-v3 operation identity is immutable';
  end if;
  if NEW.version <> OLD.version + 1 or NEW.updated_at <= OLD.updated_at then
    raise exception 'science-v3 operation update must advance version and updated_at';
  end if;
  if OLD.status <> NEW.status and not (
    (OLD.status = 'accepted' and NEW.status in ('running', 'failed', 'cancelled'))
    or (OLD.status = 'running' and NEW.status in ('succeeded', 'needs_input', 'failed', 'cancelled'))
    or (OLD.status = 'needs_input' and NEW.status in ('running', 'failed', 'cancelled'))
  ) then
    raise exception 'invalid science-v3 operation transition % -> %', OLD.status, NEW.status;
  end if;
  return NEW;
end
$$ language plpgsql;
create trigger science_v3_operation_guard
  before update or delete on science_v3_operation
  for each row execute function science_v3_operation_guard();

create trigger science_v3_operation_result_immutable
  before update or delete on science_v3_operation_result
  for each row execute function forbid_mutation();
create trigger science_v3_workflow_correlation_immutable
  before update or delete on science_v3_workflow_correlation
  for each row execute function forbid_mutation();
create trigger science_v3_agent_artifact_immutable
  before update or delete on science_v3_agent_artifact
  for each row execute function forbid_mutation();
create trigger science_v3_agent_attempt_guard before update on science_v3_agent_attempt
  for each row execute function forbid_mutation_except(
    'status', 'output_ref', 'resolved_model_id', 'input_tokens', 'output_tokens',
    'error_code', 'error_detail', 'completed_at'
  );
create trigger science_v3_agent_attempt_no_delete before delete on science_v3_agent_attempt
  for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_operation', 'science_v3_operation_result',
    'science_v3_workflow_correlation', 'science_v3_agent_artifact',
    'science_v3_agent_attempt'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.current_tenant'', true)) with check (tenant_id = current_setting(''app.current_tenant'', true))',
      t
    );
  end loop;
end
$$;

-- Relay discovery is intentionally a narrow SECURITY DEFINER API.  It exposes
-- only stable IDs and opaque references across tenants; it cannot read facts,
-- content, user data or credentials.  Duplicate reads are safe because the
-- Workflow ID is deterministic and Temporal rejects duplicate starts.
create or replace function mathpilot_science_v3_pending_workflow_starts(p_limit integer default 32)
returns table (
  event_id text,
  tenant_id text,
  operation_id text,
  event_type text,
  aggregate_ref text,
  aggregate_version bigint,
  payload_ref text,
  occurred_at timestamptz,
  delivery_attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100';
  end if;
  return query
    select o.event_id, o.tenant_id, o.operation_id, o.event_type,
           o.aggregate_type || ':' || o.aggregate_id,
           o.aggregate_version, o.payload_ref, o.occurred_at, o.delivery_attempts
      from public.infra_outbox o
     where o.published_at is null
       -- P1 starts only workflows whose owning domain transaction exists.
       -- FinalizeQuestion (P2) and correction replay (P3) extend this relay
       -- entrypoint when their facts and commit Activities are installed.
       and o.event_type in (
         'selection.intent_revised', 'question.closed',
         'dream.rem_requested', 'dream.deep_requested'
       )
     order by o.occurred_at, o.event_id
     limit p_limit;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_started(
  p_event_id text,
  p_workflow_id text,
  p_task_queue text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target public.infra_outbox%rowtype;
  expected_workflow_id text;
  existing public.science_v3_workflow_correlation%rowtype;
begin
  if p_task_queue !~ '^[a-z][a-z0-9_-]{1,119}$' then
    raise exception 'invalid task queue';
  end if;
  select * into target
    from public.infra_outbox o
   where o.event_id = p_event_id
     and o.event_type in (
       'question.cut_requested', 'selection.intent_revised', 'question.closed',
       'dream.rem_requested', 'dream.deep_requested', 'teacher.correction_recorded'
     );
  if not found then return false; end if;
  expected_workflow_id := target.event_type || ':' || target.event_id;
  if p_workflow_id <> expected_workflow_id then
    raise exception 'workflow ID must be %', expected_workflow_id;
  end if;

  insert into public.science_v3_workflow_correlation (
    event_id, tenant_id, operation_id, workflow_id, aggregate_ref,
    aggregate_version, task_queue
  ) values (
    target.event_id, target.tenant_id, target.operation_id, p_workflow_id,
    target.aggregate_type || ':' || target.aggregate_id,
    target.aggregate_version, p_task_queue
  ) on conflict (event_id) do nothing;

  select * into existing
    from public.science_v3_workflow_correlation c
   where c.event_id = p_event_id;
  if existing.workflow_id <> p_workflow_id or existing.task_queue <> p_task_queue then
    raise exception 'event already correlated to a different Workflow';
  end if;

  update public.infra_outbox o
     set published_at = coalesce(o.published_at, now()),
         workflow_id = p_workflow_id,
         delivery_attempts = case when o.published_at is null then o.delivery_attempts + 1 else o.delivery_attempts end,
         last_delivery_attempt_at = case when o.published_at is null then now() else o.last_delivery_attempt_at end,
         last_delivery_error = null
   where o.event_id = p_event_id;
  return true;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_start_failed(
  p_event_id text,
  p_error text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.infra_outbox o
     set delivery_attempts = o.delivery_attempts + 1,
         last_delivery_attempt_at = now(),
         last_delivery_error = left(coalesce(p_error, 'unknown error'), 1000)
   where o.event_id = p_event_id
     and o.published_at is null
     and o.event_type in (
       'question.cut_requested', 'selection.intent_revised', 'question.closed',
       'dream.rem_requested', 'dream.deep_requested', 'teacher.correction_recorded'
     );
  return found;
end
$$;

revoke all on function mathpilot_science_v3_pending_workflow_starts(integer) from public;
revoke all on function mathpilot_science_v3_mark_workflow_started(text,text,text) from public;
revoke all on function mathpilot_science_v3_mark_workflow_start_failed(text,text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mathpilot_app') then
    grant select, insert, update on science_v3_operation to mathpilot_app;
    grant select, insert on science_v3_operation_result to mathpilot_app;
    grant select, insert on science_v3_workflow_correlation to mathpilot_app;
    grant select, insert on science_v3_agent_artifact to mathpilot_app;
    grant select, insert, update on science_v3_agent_attempt to mathpilot_app;
    grant execute on function mathpilot_science_v3_pending_workflow_starts(integer) to mathpilot_app;
    grant execute on function mathpilot_science_v3_mark_workflow_started(text,text,text) to mathpilot_app;
    grant execute on function mathpilot_science_v3_mark_workflow_start_failed(text,text) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0032_science_v3_runtime');
commit;
