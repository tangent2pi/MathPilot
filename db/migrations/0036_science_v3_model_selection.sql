-- 0036: science-v3 Selector facts, catalog audit and QuestionOpened projection.
--
-- This migration extends only the normalized Next content and science-v3
-- runtime. It never reads, maps, backfills or exposes legacy question tables.
begin;

-- Agent attempt identifiers are globally unique, but selection facts carry the
-- tenant in every foreign key. Expose the matching composite key so PostgreSQL
-- can enforce that both values refer to the same science-v3 attempt.
alter table science_v3_agent_attempt
  add constraint science_v3_agent_attempt_tenant_attempt_key
  unique (tenant_id,agent_attempt_id);

-- One accepted revise-intent command owns one operation, immutable input
-- artifact and outbox delivery. The final operation result is written only by
-- commitSelection after the model proposal has passed host revalidation.
create table science_v3_selection_request (
  tenant_id             text not null references identity_tenant(tenant_id),
  operation_id          text primary key,
  idempotency_key       text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  command_sha256        text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
  event_id              text not null unique,
  selection_intent_id   text not null,
  intent_revision       bigint not null check (intent_revision > 0),
  input_artifact_id     text not null,
  requested_at          timestamptz not null,
  unique (tenant_id,idempotency_key),
  unique (tenant_id,selection_intent_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,event_id)
    references infra_outbox(tenant_id,event_id),
  foreign key (tenant_id,selection_intent_id)
    references science_v3_selection_intent(tenant_id,selection_intent_id),
  foreign key (tenant_id,input_artifact_id)
    references science_v3_agent_artifact(tenant_id,artifact_id)
);

-- Every question_catalog call is an append-only authorization audit. Cursor
-- scope and candidate IDs are host-produced; the model cannot inject tenant,
-- student, SQL, visibility rules or arbitrary content scopes.
create table science_v3_selection_catalog_page (
  catalog_page_id        text primary key check (catalog_page_id ~ '^cpg_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  operation_id           text not null,
  agent_attempt_id       text not null,
  tool_call_id           text not null check (length(tool_call_id) between 1 and 255),
  selection_intent_id    text not null,
  intent_revision        bigint not null check (intent_revision > 0),
  query_text             text not null check (length(query_text) <= 500),
  input_cursor           text check (length(input_cursor) <= 512),
  next_cursor            text check (length(next_cursor) <= 512),
  candidate_revision_ids text[] not null,
  constraints_digest     text not null check (constraints_digest ~ '^[0-9a-f]{64}$'),
  created_at             timestamptz not null default now(),
  unique (tenant_id,catalog_page_id),
  unique (tenant_id,agent_attempt_id,tool_call_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,agent_attempt_id)
    references science_v3_agent_attempt(tenant_id,agent_attempt_id),
  foreign key (tenant_id,selection_intent_id)
    references science_v3_selection_intent(tenant_id,selection_intent_id),
  check (cardinality(candidate_revision_ids) between 0 and 50),
  check (input_cursor is null or input_cursor <> next_cursor)
);
create index science_v3_selection_catalog_candidate_idx
  on science_v3_selection_catalog_page using gin(candidate_revision_ids);

-- SelectionDecision is the audited model proposal plus host-owned execution
-- provenance. It is not authoritative until the same transaction creates the
-- QuestionSession or records an honest no-candidate result.
create table science_v3_selection_decision (
  selection_decision_id       text primary key check (selection_decision_id ~ '^sdec_[A-Za-z0-9]{8,}$'),
  tenant_id                   text not null references identity_tenant(tenant_id),
  operation_id                text not null,
  selection_intent_id         text not null,
  intent_revision             bigint not null check (intent_revision > 0),
  decision_status             text not null check (decision_status in ('selected','no_candidate')),
  chosen_question_revision_id text,
  satisfied_requirements      text[] not null default '{}',
  unsatisfied_preferences     text[] not null default '{}',
  scientific_purpose          text check (scientific_purpose in ('measure','discriminate','remediate','verify','practice')),
  target_dimension_revision_ids text[] not null default '{}',
  target_error_cause_revision_ids text[] not null default '{}',
  evidence_refs               text[] not null,
  decision_summary            text not null check (length(decision_summary) between 1 and 1000),
  search_summary              text check (length(search_summary) between 1 and 2000),
  agent_attempt_id            text not null,
  output_ref                  text not null check (output_ref ~ '^agent-artifact:art_[A-Za-z0-9]{8,}$'),
  model_id                    text not null check (length(model_id) between 1 and 160),
  prompt_version              text not null check (length(prompt_version) between 1 and 160),
  skill_ref                   text not null check (skill_ref ~ '^skill:[a-z0-9][a-z0-9_-]+@v[1-9][0-9]*(\.[0-9]+){0,2}$'),
  created_at                  timestamptz not null,
  unique (tenant_id,selection_decision_id),
  unique (tenant_id,operation_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,selection_intent_id)
    references science_v3_selection_intent(tenant_id,selection_intent_id),
  foreign key (tenant_id,chosen_question_revision_id)
    references content_question_revision(tenant_id,revision_id),
  foreign key (tenant_id,agent_attempt_id)
    references science_v3_agent_attempt(tenant_id,agent_attempt_id),
  check (cardinality(satisfied_requirements) <= 16),
  check (cardinality(unsatisfied_preferences) <= 16),
  check (cardinality(target_dimension_revision_ids) <= 32),
  check (cardinality(target_error_cause_revision_ids) <= 32),
  check (cardinality(evidence_refs) between 1 and 64),
  check (
    (decision_status='selected' and chosen_question_revision_id is not null
      and scientific_purpose is not null and cardinality(satisfied_requirements)>0
      and search_summary is null)
    or
    (decision_status='no_candidate' and chosen_question_revision_id is null
      and scientific_purpose is null and cardinality(satisfied_requirements)=0
      and cardinality(target_dimension_revision_ids)=0
      and cardinality(target_error_cause_revision_ids)=0
      and search_summary is not null)
  )
);

-- The domain event behind the canonical QuestionCard. The message contains a
-- safe snapshot (stem/options/source only), never answer, analysis or rubric.
create table science_v3_question_opened (
  question_opened_id     text primary key check (question_opened_id ~ '^qopen_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  question_session_id    text not null,
  selection_decision_id  text not null,
  question_revision_id   text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  message_id             text not null,
  occurred_at            timestamptz not null,
  event_version          bigint not null default 1 check (event_version=1),
  unique (tenant_id,question_opened_id),
  unique (tenant_id,question_session_id),
  unique (tenant_id,message_id),
  foreign key (tenant_id,question_session_id)
    references science_v3_question_session(tenant_id,question_session_id),
  foreign key (tenant_id,selection_decision_id)
    references science_v3_selection_decision(tenant_id,selection_decision_id),
  foreign key (tenant_id,question_revision_id)
    references content_question_revision(tenant_id,revision_id),
  foreign key (tenant_id,message_id)
    references science_v3_canonical_message(tenant_id,message_id)
);

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_selection_request','science_v3_selection_catalog_page',
    'science_v3_selection_decision','science_v3_question_opened'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()',t || '_immutable',t);
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id=current_setting(''app.current_tenant'',true)) with check (tenant_id=current_setting(''app.current_tenant'',true))',t
    );
  end loop;
end
$$;

-- Several intent revisions intentionally signal the same per-Thread Temporal
-- Workflow. Correlation remains one row per outbox event, while workflow_id is
-- now an indexed many-to-one audit field.
alter table science_v3_workflow_correlation
  drop constraint if exists science_v3_workflow_correlation_workflow_id_key;
create index if not exists science_v3_workflow_correlation_workflow_idx
  on science_v3_workflow_correlation(workflow_id,created_at);

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
   where o.event_id=p_event_id
     and o.event_type in (
       'question.cut_requested','selection.intent_revised','question.closed',
       'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
     );
  if not found then return false; end if;

  if target.event_type='selection.intent_revised'
     and target.aggregate_type='conversation-thread' then
    expected_workflow_id := 'select-question:' || target.tenant_id || ':' || target.aggregate_id;
  else
    expected_workflow_id := target.event_type || ':' || target.event_id;
  end if;
  if p_workflow_id <> expected_workflow_id then
    raise exception 'workflow ID must be %',expected_workflow_id;
  end if;

  insert into public.science_v3_workflow_correlation(
    event_id,tenant_id,operation_id,workflow_id,aggregate_ref,
    aggregate_version,task_queue
  ) values (
    target.event_id,target.tenant_id,target.operation_id,p_workflow_id,
    target.aggregate_type || ':' || target.aggregate_id,
    target.aggregate_version,p_task_queue
  ) on conflict(event_id) do nothing;

  select * into existing from public.science_v3_workflow_correlation c
   where c.event_id=p_event_id;
  if existing.workflow_id <> p_workflow_id or existing.task_queue <> p_task_queue then
    raise exception 'event already correlated to a different Workflow';
  end if;

  update public.infra_outbox o
     set published_at=coalesce(o.published_at,now()),
         workflow_id=p_workflow_id,
         delivery_attempts=case when o.published_at is null then o.delivery_attempts+1 else o.delivery_attempts end,
         last_delivery_attempt_at=case when o.published_at is null then now() else o.last_delivery_attempt_at end,
         last_delivery_error=null
   where o.event_id=p_event_id;
  return true;
end
$$;

do $$
begin
  if exists(select 1 from pg_roles where rolname='mathpilot_app') then
    grant select,insert on science_v3_selection_request to mathpilot_app;
    grant select,insert on science_v3_selection_catalog_page to mathpilot_app;
    grant select,insert on science_v3_selection_decision to mathpilot_app;
    grant select,insert on science_v3_question_opened to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0036_science_v3_model_selection');
commit;
