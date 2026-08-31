-- 0033: science-v3 question facts and atomic cut boundary.
--
-- This migration creates the Next question-flow authority from its frozen v3
-- contracts. It does not read, backfill, dual-write or otherwise depend on the
-- legacy runtime_* learning tables.
begin;

-- Contract-level student identities are intentionally distinct from login
-- user IDs. Provisioning binds them explicitly instead of reusing a Thread,
-- QuestionSession or authentication identity as a student fact identity.
create table science_v3_student (
  student_id  text primary key check (student_id ~ '^stu_[A-Za-z0-9]{8,}$'),
  tenant_id   text not null references identity_tenant(tenant_id),
  user_id     text not null references identity_user(user_id),
  created_at  timestamptz not null default now(),
  unique (tenant_id, student_id),
  unique (tenant_id, user_id)
);

create table science_v3_conversation_thread (
  conversation_thread_id text primary key check (conversation_thread_id ~ '^thr_[A-Za-z0-9]{8,}$'),
  tenant_id               text not null references identity_tenant(tenant_id),
  student_id              text not null,
  status                  text not null default 'active' check (status in ('active', 'archived')),
  next_message_sequence   bigint not null default 1 check (next_message_sequence > 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  version                 bigint not null default 1 check (version > 0),
  unique (tenant_id, conversation_thread_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id)
);
create index science_v3_thread_student_idx
  on science_v3_conversation_thread (tenant_id, student_id, updated_at desc);

create table science_v3_learning_activity (
  learning_activity_id text primary key check (learning_activity_id ~ '^lac_[A-Za-z0-9]{8,}$'),
  tenant_id           text not null references identity_tenant(tenant_id),
  student_id          text not null,
  goal                text not null check (length(goal) between 1 and 2000),
  source              text not null check (source in ('student', 'program', 'teacher')),
  policy              jsonb not null,
  status              text not null default 'active' check (status in ('active', 'paused', 'completed', 'cancelled')),
  created_at          timestamptz not null default now(),
  closed_at           timestamptz,
  version             bigint not null default 1 check (version > 0),
  unique (tenant_id, learning_activity_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  check (jsonb_typeof(policy) = 'object'),
  check (policy ?& array['coverage','budget','stopping','evidence_requirements']),
  check ((status in ('completed','cancelled')) = (closed_at is not null))
);
create index science_v3_learning_activity_student_idx
  on science_v3_learning_activity (tenant_id, student_id, status, created_at desc);

create table science_v3_selection_intent (
  selection_intent_id      text primary key check (selection_intent_id ~ '^int_[A-Za-z0-9]{8,}$'),
  tenant_id                text not null references identity_tenant(tenant_id),
  conversation_thread_id   text not null,
  student_id               text not null,
  revision                 bigint not null check (revision > 0),
  source                   text not null check (source in ('student', 'program', 'teacher')),
  natural_language_request text not null check (length(natural_language_request) between 1 and 4000),
  activity_constraints     jsonb not null default '{}'::jsonb,
  context_snapshot_ref     text not null check (context_snapshot_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  supersedes_intent_id     text,
  created_at               timestamptz not null default now(),
  unique (tenant_id, selection_intent_id),
  unique (tenant_id, conversation_thread_id, revision),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, supersedes_intent_id)
    references science_v3_selection_intent(tenant_id, selection_intent_id),
  check (jsonb_typeof(activity_constraints) = 'object'),
  check ((revision = 1 and supersedes_intent_id is null)
      or (revision > 1 and supersedes_intent_id is not null))
);
create index science_v3_selection_intent_latest_idx
  on science_v3_selection_intent (tenant_id, conversation_thread_id, revision desc);

-- Existing content revisions are globally identified, but the composite key
-- lets question facts prove tenant alignment with an ordinary foreign key.
create unique index content_question_revision_tenant_revision_uidx
  on content_question_revision (tenant_id, revision_id);

create table science_v3_question_session (
  question_session_id       text primary key check (question_session_id ~ '^qsn_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  conversation_thread_id    text not null,
  student_id                text not null,
  learning_activity_id      text,
  selection_intent_id       text not null,
  selection_intent_revision bigint not null check (selection_intent_revision > 0),
  question_revision_id      text,
  external_question_ref     text,
  source                    text not null check (source in ('catalog', 'student_external', 'generated_provisional')),
  frozen_measurement_contract jsonb not null,
  lifecycle                 text not null default 'active' check (lifecycle in ('active', 'finalizing', 'closed', 'abandoned')),
  frozen_attempt_sequence   bigint,
  opened_at                 timestamptz not null default now(),
  closed_at                 timestamptz,
  close_reason              text check (close_reason in ('completed', 'student_switch', 'skipped', 'teacher_switch', 'system_policy', 'abandoned')),
  revisit_of_question_session_id text,
  version                   bigint not null default 1 check (version > 0),
  unique (tenant_id, question_session_id),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, learning_activity_id)
    references science_v3_learning_activity(tenant_id, learning_activity_id),
  foreign key (tenant_id, selection_intent_id)
    references science_v3_selection_intent(tenant_id, selection_intent_id),
  foreign key (tenant_id, question_revision_id)
    references content_question_revision(tenant_id, revision_id),
  foreign key (tenant_id, revisit_of_question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  check ((question_revision_id is not null)::integer + (external_question_ref is not null)::integer = 1),
  check (external_question_ref is null or external_question_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  check ((source = 'catalog') = (question_revision_id is not null)),
  check (jsonb_typeof(frozen_measurement_contract) = 'object'),
  check (frozen_measurement_contract ?& array[
    'contract_version','measurement_eligibility','rubric_revision_id',
    'dimension_revision_ids','diagnosis_rule_revision_ids','evidence_policy_version'
  ]),
  check ((lifecycle in ('closed','abandoned')) = (closed_at is not null and close_reason is not null)),
  check ((lifecycle = 'active') = (frozen_attempt_sequence is null))
);
create unique index science_v3_question_session_open_slot_uidx
  on science_v3_question_session (tenant_id, conversation_thread_id)
  where lifecycle in ('active', 'finalizing');
create index science_v3_question_session_student_idx
  on science_v3_question_session (tenant_id, student_id, opened_at desc);

create table science_v3_foreground_agent_epoch (
  foreground_epoch_id       text primary key check (foreground_epoch_id ~ '^fge_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  conversation_thread_id    text not null,
  student_id                text not null,
  active_question_session_id text,
  context_snapshot_ref      text not null check (context_snapshot_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  workspace_snapshot_version bigint not null check (workspace_snapshot_version > 0),
  started_at                timestamptz not null default now(),
  ended_at                  timestamptz,
  version                   bigint not null default 1 check (version > 0),
  unique (tenant_id, foreground_epoch_id),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, active_question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  check (ended_at is null or ended_at >= started_at)
);
create unique index science_v3_foreground_epoch_active_uidx
  on science_v3_foreground_agent_epoch (tenant_id, conversation_thread_id)
  where ended_at is null;

create table science_v3_canonical_message (
  message_id             text primary key check (message_id ~ '^msg_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  conversation_thread_id text not null,
  sequence               bigint not null check (sequence > 0),
  author_kind            text not null check (author_kind in ('student', 'assistant', 'system')),
  author_user_id         text references identity_user(user_id),
  foreground_epoch_id    text,
  lifecycle              text not null check (lifecycle in ('streaming', 'committed', 'failed', 'superseded')),
  parts                  jsonb not null,
  reply_to_message_id    text,
  question_session_id    text,
  editable               boolean not null,
  lock_reason            text check (lock_reason in ('attempt_recorded', 'intent_recorded', 'domain_event', 'evidence_recorded', 'superseded')),
  created_at             timestamptz not null default now(),
  supersedes_message_id  text,
  version                bigint not null default 1 check (version > 0),
  unique (tenant_id, message_id),
  unique (tenant_id, conversation_thread_id, sequence),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id),
  foreign key (tenant_id, foreground_epoch_id)
    references science_v3_foreground_agent_epoch(tenant_id, foreground_epoch_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, reply_to_message_id)
    references science_v3_canonical_message(tenant_id, message_id),
  foreign key (tenant_id, supersedes_message_id)
    references science_v3_canonical_message(tenant_id, message_id),
  check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) > 0),
  check (pg_column_size(parts) <= 1048576),
  check (editable or lock_reason is not null),
  check ((lifecycle = 'superseded') = (supersedes_message_id is not null)),
  check ((author_kind = 'student') = (author_user_id is not null))
);
create index science_v3_canonical_message_thread_idx
  on science_v3_canonical_message (tenant_id, conversation_thread_id, sequence);

create table science_v3_attempt (
  attempt_id             text primary key check (attempt_id ~ '^att_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  question_session_id    text not null,
  question_revision_id   text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  student_id             text not null,
  kind                   text not null check (kind in ('answer', 'probe', 'correction', 'explanation')),
  content_refs           text[] not null,
  message_id             text not null,
  hint_level             integer not null check (hint_level between 0 and 5),
  session_sequence       bigint not null check (session_sequence > 0),
  admitted_session_version bigint not null check (admitted_session_version > 0),
  idempotency_key        text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  submitted_at           timestamptz not null,
  supersedes_attempt_id  text,
  fact_version           bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, attempt_id),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, question_session_id, session_sequence),
  unique (tenant_id, message_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, message_id)
    references science_v3_canonical_message(tenant_id, message_id),
  foreign key (tenant_id, supersedes_attempt_id)
    references science_v3_attempt(tenant_id, attempt_id),
  check (cardinality(content_refs) between 1 and 32),
  check (array_to_string(content_refs, E'\n') ~ '^[a-z][a-z0-9+.-]*://[^[:space:]]+(\n[a-z][a-z0-9+.-]*://[^[:space:]]+)*$'),
  check ((supersedes_attempt_id is null and fact_version = 1)
      or (supersedes_attempt_id is not null and fact_version > 1))
);
create index science_v3_attempt_session_idx
  on science_v3_attempt (tenant_id, question_session_id, session_sequence);

create table science_v3_judgment (
  judgment_id           text primary key check (judgment_id ~ '^jdg_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  attempt_id            text not null,
  verdict               text not null check (verdict in ('correct', 'partially_correct', 'incorrect', 'unresolved')),
  rubric_results        jsonb not null,
  dimension_proposals   jsonb not null,
  uncertainty           text not null check (uncertainty in ('low', 'medium', 'high')),
  decision_summary      text not null check (length(decision_summary) between 1 and 2000),
  evidence_refs         text[] not null,
  model_id              text not null check (length(model_id) between 1 and 160),
  prompt_version        text not null check (length(prompt_version) between 1 and 160),
  skill_version         text not null check (length(skill_version) between 1 and 160),
  created_at            timestamptz not null,
  supersedes_judgment_id text,
  fact_version          bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, judgment_id),
  unique (tenant_id, attempt_id, fact_version),
  foreign key (tenant_id, attempt_id)
    references science_v3_attempt(tenant_id, attempt_id),
  foreign key (tenant_id, supersedes_judgment_id)
    references science_v3_judgment(tenant_id, judgment_id),
  check (jsonb_typeof(rubric_results) = 'array' and jsonb_array_length(rubric_results) > 0),
  check (jsonb_typeof(dimension_proposals) = 'array'),
  check (cardinality(evidence_refs) between 1 and 64),
  check ((supersedes_judgment_id is null and fact_version = 1)
      or (supersedes_judgment_id is not null and fact_version > 1))
);
create index science_v3_judgment_attempt_idx
  on science_v3_judgment (tenant_id, attempt_id, fact_version desc);

create table science_v3_observation (
  observation_id        text primary key check (observation_id ~ '^obs_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  student_id            text not null,
  dimension_revision_id text not null check (dimension_revision_id ~ '^(krev|trev)_[A-Za-z0-9_.:-]{4,}$'),
  question_session_id   text not null,
  question_revision_id  text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  judgment_id           text not null,
  outcome               text not null check (outcome in ('success', 'failure')),
  eligibility           text not null default 'independent_measurement' check (eligibility = 'independent_measurement'),
  measurement_rule_id   text not null check (length(measurement_rule_id) between 1 and 160),
  hint_level            integer not null default 0 check (hint_level = 0),
  evidence_refs         text[] not null,
  occurred_at           timestamptz not null,
  policy_version        text not null check (length(policy_version) between 1 and 160),
  supersedes_observation_id text,
  fact_version          bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, observation_id),
  unique (tenant_id, judgment_id, dimension_revision_id, measurement_rule_id, fact_version),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, judgment_id)
    references science_v3_judgment(tenant_id, judgment_id),
  foreign key (tenant_id, supersedes_observation_id)
    references science_v3_observation(tenant_id, observation_id),
  check (cardinality(evidence_refs) between 1 and 64),
  check ((supersedes_observation_id is null and fact_version = 1)
      or (supersedes_observation_id is not null and fact_version > 1))
);
create index science_v3_observation_replay_idx
  on science_v3_observation (tenant_id, student_id, dimension_revision_id, occurred_at, observation_id);

create table science_v3_cut_request (
  cut_request_id          text primary key check (cut_request_id ~ '^cut_[A-Za-z0-9]{8,}$'),
  tenant_id               text not null references identity_tenant(tenant_id),
  conversation_thread_id  text not null,
  question_session_id     text not null,
  operation_id            text not null,
  idempotency_key         text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  expected_session_version bigint not null check (expected_session_version > 0),
  frozen_attempt_sequence bigint not null check (frozen_attempt_sequence >= 0),
  reason                  text not null check (reason in ('completed', 'student_switch', 'skipped', 'teacher_switch', 'system_policy', 'abandoned')),
  next_intent_ref         text,
  payload_ref             text not null check (payload_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  requested_at            timestamptz not null,
  unique (tenant_id, cut_request_id),
  unique (tenant_id, question_session_id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  check (next_intent_ref is null or next_intent_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$')
);

create table science_v3_question_closure (
  question_closure_id   text primary key check (question_closure_id ~ '^qcl_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  question_session_id   text not null,
  cut_request_id        text not null,
  operation_id          text not null,
  close_reason          text not null check (close_reason in ('completed', 'student_switch', 'skipped', 'teacher_switch', 'system_policy', 'abandoned')),
  diagnostic_status     text not null check (diagnostic_status in ('concluded', 'inconclusive', 'skipped', 'unclassified')),
  judgment_refs         text[] not null default '{}',
  observation_refs      text[] not null default '{}',
  scientific_commit_version bigint not null default 1 check (scientific_commit_version > 0),
  closed_at             timestamptz not null,
  version               bigint not null default 1 check (version > 0),
  unique (tenant_id, question_closure_id),
  unique (tenant_id, question_session_id),
  unique (tenant_id, cut_request_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, cut_request_id)
    references science_v3_cut_request(tenant_id, cut_request_id),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  check (cardinality(judgment_refs) <= 128),
  check (cardinality(observation_refs) <= 256)
);

create or replace function science_v3_thread_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'science-v3 conversation thread cannot be deleted'; end if;
  if new.conversation_thread_id is distinct from old.conversation_thread_id
     or new.tenant_id is distinct from old.tenant_id
     or new.student_id is distinct from old.student_id
     or new.created_at is distinct from old.created_at then
    raise exception 'science-v3 conversation thread identity is immutable';
  end if;
  if new.version <> old.version + 1 or new.updated_at <= old.updated_at then
    raise exception 'science-v3 conversation thread update must advance version and updated_at';
  end if;
  if old.status = 'archived' and new.status <> old.status then
    raise exception 'archived conversation thread cannot be reopened';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_thread_guard before update or delete on science_v3_conversation_thread
  for each row execute function science_v3_thread_guard();

create or replace function science_v3_learning_activity_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'science-v3 learning activity cannot be deleted'; end if;
  if new.learning_activity_id is distinct from old.learning_activity_id
     or new.tenant_id is distinct from old.tenant_id
     or new.student_id is distinct from old.student_id
     or new.goal is distinct from old.goal
     or new.source is distinct from old.source
     or new.policy is distinct from old.policy
     or new.created_at is distinct from old.created_at then
    raise exception 'science-v3 learning activity facts are immutable';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'science-v3 learning activity update must advance version';
  end if;
  if old.status <> new.status and not (
    (old.status = 'active' and new.status in ('paused','completed','cancelled'))
    or (old.status = 'paused' and new.status in ('active','cancelled'))
  ) then
    raise exception 'invalid learning activity transition % -> %', old.status, new.status;
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_learning_activity_guard before update or delete on science_v3_learning_activity
  for each row execute function science_v3_learning_activity_guard();

create or replace function science_v3_question_session_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'science-v3 question session cannot be deleted'; end if;
  if new.question_session_id is distinct from old.question_session_id
     or new.tenant_id is distinct from old.tenant_id
     or new.conversation_thread_id is distinct from old.conversation_thread_id
     or new.student_id is distinct from old.student_id
     or new.learning_activity_id is distinct from old.learning_activity_id
     or new.selection_intent_id is distinct from old.selection_intent_id
     or new.selection_intent_revision is distinct from old.selection_intent_revision
     or new.question_revision_id is distinct from old.question_revision_id
     or new.external_question_ref is distinct from old.external_question_ref
     or new.source is distinct from old.source
     or new.frozen_measurement_contract is distinct from old.frozen_measurement_contract
     or new.opened_at is distinct from old.opened_at
     or new.revisit_of_question_session_id is distinct from old.revisit_of_question_session_id then
    raise exception 'science-v3 question session frozen identity is immutable';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'science-v3 question session update must advance version';
  end if;
  if old.lifecycle <> new.lifecycle and not (
    (old.lifecycle = 'active' and new.lifecycle in ('finalizing','abandoned'))
    or (old.lifecycle = 'finalizing' and new.lifecycle in ('closed','abandoned'))
  ) then
    raise exception 'invalid question session transition % -> %', old.lifecycle, new.lifecycle;
  end if;
  if old.lifecycle in ('closed','abandoned') then
    raise exception 'closed question session is immutable';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_question_session_guard before update or delete on science_v3_question_session
  for each row execute function science_v3_question_session_guard();

create or replace function science_v3_foreground_epoch_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'science-v3 foreground epoch cannot be deleted'; end if;
  if new.foreground_epoch_id is distinct from old.foreground_epoch_id
     or new.tenant_id is distinct from old.tenant_id
     or new.conversation_thread_id is distinct from old.conversation_thread_id
     or new.student_id is distinct from old.student_id
     or new.active_question_session_id is distinct from old.active_question_session_id
     or new.context_snapshot_ref is distinct from old.context_snapshot_ref
     or new.workspace_snapshot_version is distinct from old.workspace_snapshot_version
     or new.started_at is distinct from old.started_at then
    raise exception 'science-v3 foreground epoch identity and snapshot are immutable';
  end if;
  if old.ended_at is not null or new.ended_at is null or new.version <> old.version + 1 then
    raise exception 'foreground epoch can only be ended once with an advanced version';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_foreground_epoch_guard before update or delete on science_v3_foreground_agent_epoch
  for each row execute function science_v3_foreground_epoch_guard();

create or replace function science_v3_canonical_message_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'canonical message cannot be deleted'; end if;
  if old.lifecycle <> 'streaming' then
    raise exception 'committed canonical message is append-only; supersede with a new message';
  end if;
  if new.message_id is distinct from old.message_id
     or new.tenant_id is distinct from old.tenant_id
     or new.conversation_thread_id is distinct from old.conversation_thread_id
     or new.sequence is distinct from old.sequence
     or new.author_kind is distinct from old.author_kind
     or new.author_user_id is distinct from old.author_user_id
     or new.foreground_epoch_id is distinct from old.foreground_epoch_id
     or new.reply_to_message_id is distinct from old.reply_to_message_id
     or new.question_session_id is distinct from old.question_session_id
     or new.created_at is distinct from old.created_at
     or new.supersedes_message_id is distinct from old.supersedes_message_id then
    raise exception 'canonical message identity is immutable';
  end if;
  if new.lifecycle not in ('streaming','committed','failed') or new.version <> old.version + 1 then
    raise exception 'invalid canonical message stream transition';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_canonical_message_guard before update or delete on science_v3_canonical_message
  for each row execute function science_v3_canonical_message_guard();

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_student', 'science_v3_selection_intent', 'science_v3_attempt',
    'science_v3_judgment', 'science_v3_observation', 'science_v3_cut_request',
    'science_v3_question_closure'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()', t || '_immutable', t);
  end loop;
end
$$;

create or replace function mathpilot_science_v3_record_selection_intent(
  p_tenant_id text,
  p_selection_intent_id text,
  p_conversation_thread_id text,
  p_student_id text,
  p_revision bigint,
  p_source text,
  p_natural_language_request text,
  p_activity_constraints jsonb,
  p_context_snapshot_ref text,
  p_supersedes_intent_id text,
  p_created_at timestamptz
) returns table (selection_intent_id text, revision bigint)
language plpgsql
as $$
declare
  v_thread science_v3_conversation_thread%rowtype;
  v_latest science_v3_selection_intent%rowtype;
  v_existing science_v3_selection_intent%rowtype;
begin
  select * into v_thread from science_v3_conversation_thread
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id
   for update;
  if not found or v_thread.student_id <> p_student_id or v_thread.status <> 'active' then
    raise exception 'active conversation thread does not belong to student';
  end if;

  select * into v_existing from science_v3_selection_intent
   where tenant_id=p_tenant_id and science_v3_selection_intent.selection_intent_id=p_selection_intent_id;
  if found then
    if v_existing.conversation_thread_id <> p_conversation_thread_id
       or v_existing.student_id <> p_student_id
       or v_existing.revision <> p_revision
       or v_existing.natural_language_request <> p_natural_language_request then
      raise exception 'selection intent ID is already bound to different facts';
    end if;
    return query select v_existing.selection_intent_id, v_existing.revision;
    return;
  end if;

  select * into v_latest from science_v3_selection_intent
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id
   order by revision desc limit 1;
  if p_revision <> coalesce(v_latest.revision,0) + 1 then
    raise exception 'selection intent revision must be the next revision';
  end if;
  if p_revision = 1 and p_supersedes_intent_id is not null
     or p_revision > 1 and p_supersedes_intent_id is distinct from v_latest.selection_intent_id then
    raise exception 'selection intent supersession does not match latest revision';
  end if;

  insert into science_v3_selection_intent (
    selection_intent_id,tenant_id,conversation_thread_id,student_id,revision,source,
    natural_language_request,activity_constraints,context_snapshot_ref,
    supersedes_intent_id,created_at
  ) values (
    p_selection_intent_id,p_tenant_id,p_conversation_thread_id,p_student_id,p_revision,p_source,
    p_natural_language_request,coalesce(p_activity_constraints,'{}'::jsonb),p_context_snapshot_ref,
    p_supersedes_intent_id,p_created_at
  );
  return query select p_selection_intent_id,p_revision;
end
$$;

create or replace function mathpilot_science_v3_open_question_session(
  p_tenant_id text,
  p_question_session_id text,
  p_conversation_thread_id text,
  p_student_id text,
  p_learning_activity_id text,
  p_selection_intent_id text,
  p_selection_intent_revision bigint,
  p_question_revision_id text,
  p_external_question_ref text,
  p_source text,
  p_frozen_measurement_contract jsonb,
  p_revisit_of_question_session_id text,
  p_foreground_epoch_id text,
  p_context_snapshot_ref text,
  p_workspace_snapshot_version bigint,
  p_opened_at timestamptz
) returns table (question_session_id text, foreground_epoch_id text, session_version bigint)
language plpgsql
as $$
declare
  v_thread science_v3_conversation_thread%rowtype;
  v_intent science_v3_selection_intent%rowtype;
  v_activity science_v3_learning_activity%rowtype;
begin
  select * into v_thread from science_v3_conversation_thread
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id
   for update;
  if not found or v_thread.student_id <> p_student_id or v_thread.status <> 'active' then
    raise exception 'active conversation thread does not belong to student';
  end if;
  select * into v_intent from science_v3_selection_intent
   where tenant_id=p_tenant_id and science_v3_selection_intent.selection_intent_id=p_selection_intent_id;
  if not found or v_intent.conversation_thread_id <> p_conversation_thread_id
     or v_intent.student_id <> p_student_id or v_intent.revision <> p_selection_intent_revision
     or exists (
       select 1 from science_v3_selection_intent newer
        where newer.tenant_id=p_tenant_id
          and newer.conversation_thread_id=p_conversation_thread_id
          and newer.revision > p_selection_intent_revision
     ) then
    raise exception 'stale selection intent';
  end if;
  if p_learning_activity_id is not null then
    select * into v_activity from science_v3_learning_activity
     where tenant_id=p_tenant_id and learning_activity_id=p_learning_activity_id;
    if not found or v_activity.student_id <> p_student_id or v_activity.status <> 'active' then
      raise exception 'learning activity is not active for student';
    end if;
  end if;
  if p_source = 'catalog' and not exists (
    select 1 from content_question_revision q
    join content_entity_revision r on r.revision_id=q.revision_id and r.tenant_id=q.tenant_id
    where q.tenant_id=p_tenant_id and q.revision_id=p_question_revision_id
      and r.lifecycle_status='ready'
  ) then
    raise exception 'catalog question revision is not ready';
  end if;

  update science_v3_foreground_agent_epoch
     set ended_at=p_opened_at,version=version+1
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id and ended_at is null;
  insert into science_v3_question_session (
    question_session_id,tenant_id,conversation_thread_id,student_id,learning_activity_id,
    selection_intent_id,selection_intent_revision,question_revision_id,external_question_ref,
    source,frozen_measurement_contract,lifecycle,opened_at,revisit_of_question_session_id,version
  ) values (
    p_question_session_id,p_tenant_id,p_conversation_thread_id,p_student_id,p_learning_activity_id,
    p_selection_intent_id,p_selection_intent_revision,p_question_revision_id,p_external_question_ref,
    p_source,p_frozen_measurement_contract,'active',p_opened_at,p_revisit_of_question_session_id,1
  );
  insert into science_v3_foreground_agent_epoch (
    foreground_epoch_id,tenant_id,conversation_thread_id,student_id,
    active_question_session_id,context_snapshot_ref,workspace_snapshot_version,started_at
  ) values (
    p_foreground_epoch_id,p_tenant_id,p_conversation_thread_id,p_student_id,
    p_question_session_id,p_context_snapshot_ref,p_workspace_snapshot_version,p_opened_at
  );
  update science_v3_conversation_thread
     set updated_at=clock_timestamp(),version=version+1
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id;
  return query select p_question_session_id,p_foreground_epoch_id,1::bigint;
end
$$;

create or replace function mathpilot_science_v3_submit_attempt(
  p_tenant_id text,
  p_requested_by_user_id text,
  p_operation_id text,
  p_idempotency_key text,
  p_attempt_id text,
  p_message_id text,
  p_conversation_thread_id text,
  p_question_session_id text,
  p_expected_session_version bigint,
  p_question_revision_id text,
  p_kind text,
  p_parts jsonb,
  p_content_refs text[],
  p_hint_level integer,
  p_submitted_at timestamptz
) returns table (
  command_operation_id text,
  admitted_attempt_id text,
  canonical_message_id text,
  session_version bigint,
  result_status text,
  rejection_code text
)
language plpgsql
as $$
declare
  v_session science_v3_question_session%rowtype;
  v_thread science_v3_conversation_thread%rowtype;
  v_attempt science_v3_attempt%rowtype;
  v_result science_v3_operation_result%rowtype;
  v_epoch_id text;
  v_sequence bigint;
  v_new_version bigint;
  v_rejection text;
begin
  if not exists (
    select 1 from science_v3_question_session q
    join science_v3_student s
      on s.tenant_id=q.tenant_id and s.student_id=q.student_id
    where q.tenant_id=p_tenant_id and q.question_session_id=p_question_session_id
      and q.conversation_thread_id=p_conversation_thread_id
      and s.user_id=p_requested_by_user_id
  ) then
    raise exception 'requested user is not the question student';
  end if;
  select * into v_result from science_v3_operation_result
   where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    select * into v_attempt from science_v3_attempt
     where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
    return query select v_result.operation_id,v_attempt.attempt_id,v_attempt.message_id,
      v_result.aggregate_version,'already_committed'::text,v_result.rejection_code;
    return;
  end if;
  insert into science_v3_operation (
    operation_id,tenant_id,requested_by_user_id,kind,status,user_message
  ) values (
    p_operation_id,p_tenant_id,p_requested_by_user_id,'submit_attempt','accepted','正在提交答案'
  );
  update science_v3_operation
     set status='running',user_message='正在提交答案',updated_at=clock_timestamp(),version=version+1
   where tenant_id=p_tenant_id and operation_id=p_operation_id;

  select * into v_session from science_v3_question_session
   where tenant_id=p_tenant_id and question_session_id=p_question_session_id
   for update;
  if not found or v_session.conversation_thread_id <> p_conversation_thread_id then
    v_rejection := 'permission_denied';
  elsif v_session.lifecycle <> 'active' then
    v_rejection := 'closed';
  elsif v_session.version <> p_expected_session_version then
    v_rejection := 'version_conflict';
  elsif v_session.question_revision_id is not null
        and v_session.question_revision_id <> p_question_revision_id then
    v_rejection := 'invalid_evidence';
  end if;

  if v_rejection is not null then
    insert into science_v3_operation_result (
      tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
      aggregate_version,result_resource_refs,rejection_code
    ) values (
      p_tenant_id,p_operation_id,p_idempotency_key,'rejected',
      'question-session:' || p_question_session_id,greatest(coalesce(v_session.version,1),1),
      array['question-session:' || p_question_session_id],v_rejection
    );
    update science_v3_operation
       set status='succeeded',user_message='本次提交未被接纳',retryable=false,
           related_resource_refs=array['question-session:' || p_question_session_id],
           updated_at=clock_timestamp(),version=version+1
     where tenant_id=p_tenant_id and operation_id=p_operation_id;
    return query select p_operation_id,null::text,null::text,
      greatest(coalesce(v_session.version,1),1), 'rejected'::text,v_rejection;
    return;
  end if;

  select * into v_thread from science_v3_conversation_thread
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id
   for update;
  if not found or v_thread.student_id <> v_session.student_id or v_thread.status <> 'active' then
    raise exception 'active conversation thread does not match question session';
  end if;
  select foreground_epoch_id into v_epoch_id
    from science_v3_foreground_agent_epoch
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id
     and active_question_session_id=p_question_session_id and ended_at is null;
  if v_epoch_id is null then raise exception 'question session has no active foreground epoch'; end if;

  v_sequence := v_thread.next_message_sequence;
  insert into science_v3_canonical_message (
    message_id,tenant_id,conversation_thread_id,sequence,author_kind,author_user_id,
    foreground_epoch_id,lifecycle,parts,question_session_id,editable,lock_reason,
    created_at,version
  ) values (
    p_message_id,p_tenant_id,p_conversation_thread_id,v_sequence,'student',p_requested_by_user_id,
    v_epoch_id,'committed',p_parts,p_question_session_id,false,'attempt_recorded',
    p_submitted_at,1
  );
  update science_v3_conversation_thread
     set next_message_sequence=next_message_sequence+1,
         updated_at=clock_timestamp(),version=version+1
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id;

  v_new_version := v_session.version + 1;
  insert into science_v3_attempt (
    attempt_id,tenant_id,question_session_id,question_revision_id,student_id,kind,
    content_refs,message_id,hint_level,session_sequence,admitted_session_version,
    idempotency_key,submitted_at,fact_version
  ) values (
    p_attempt_id,p_tenant_id,p_question_session_id,p_question_revision_id,v_session.student_id,p_kind,
    p_content_refs,p_message_id,p_hint_level,
    coalesce((select max(a.session_sequence)+1 from science_v3_attempt a
              where a.tenant_id=p_tenant_id and a.question_session_id=p_question_session_id),1),
    v_new_version,p_idempotency_key,p_submitted_at,1
  );
  update science_v3_question_session set version=v_new_version
   where tenant_id=p_tenant_id and question_session_id=p_question_session_id;

  insert into science_v3_operation_result (
    tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
    aggregate_version,result_resource_refs
  ) values (
    p_tenant_id,p_operation_id,p_idempotency_key,'committed',
    'question-session:' || p_question_session_id,v_new_version,
    array['attempt:' || p_attempt_id,'canonical-message:' || p_message_id]
  );
  update science_v3_operation
     set status='succeeded',user_message='答案已提交',retryable=false,
         related_resource_refs=array['attempt:' || p_attempt_id,'canonical-message:' || p_message_id],
         updated_at=clock_timestamp(),version=version+1
   where tenant_id=p_tenant_id and operation_id=p_operation_id;
  return query select p_operation_id,p_attempt_id,p_message_id,v_new_version,'committed'::text,null::text;
end
$$;

create or replace function mathpilot_science_v3_request_cut(
  p_tenant_id text,
  p_requested_by_user_id text,
  p_operation_id text,
  p_idempotency_key text,
  p_cut_request_id text,
  p_event_id text,
  p_artifact_id text,
  p_conversation_thread_id text,
  p_question_session_id text,
  p_expected_session_version bigint,
  p_reason text,
  p_next_intent_ref text,
  p_payload jsonb,
  p_payload_sha256 text,
  p_requested_at timestamptz
) returns table (
  command_operation_id text,
  accepted_cut_request_id text,
  session_version bigint,
  result_status text,
  rejection_code text
)
language plpgsql
as $$
declare
  v_session science_v3_question_session%rowtype;
  v_cut science_v3_cut_request%rowtype;
  v_result science_v3_operation_result%rowtype;
  v_frozen_sequence bigint;
  v_new_version bigint;
  v_rejection text;
begin
  if not exists (
    select 1 from science_v3_question_session q
    join science_v3_student s
      on s.tenant_id=q.tenant_id and s.student_id=q.student_id
    where q.tenant_id=p_tenant_id and q.question_session_id=p_question_session_id
      and q.conversation_thread_id=p_conversation_thread_id
      and s.user_id=p_requested_by_user_id
  ) then
    raise exception 'requested user is not the question student';
  end if;
  select * into v_result from science_v3_operation_result
   where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    select * into v_cut from science_v3_cut_request
     where tenant_id=p_tenant_id and operation_id=v_result.operation_id;
    return query select v_result.operation_id,v_cut.cut_request_id,
      v_result.aggregate_version,'already_committed'::text,v_result.rejection_code;
    return;
  end if;

  select * into v_cut from science_v3_cut_request
   where tenant_id=p_tenant_id
     and (question_session_id=p_question_session_id or cut_request_id=p_cut_request_id or idempotency_key=p_idempotency_key)
   order by requested_at limit 1;
  if found then
    select version into v_new_version from science_v3_question_session
     where tenant_id=p_tenant_id and question_session_id=v_cut.question_session_id;
    return query select v_cut.operation_id,v_cut.cut_request_id,v_new_version,'accepted'::text,null::text;
    return;
  end if;
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce((p_payload->>'schema_version')::integer,0) <> 3
     or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid finalize input artifact';
  end if;

  insert into science_v3_operation (
    operation_id,tenant_id,requested_by_user_id,kind,status,user_message
  ) values (
    p_operation_id,p_tenant_id,p_requested_by_user_id,'finalize_question','accepted','正在结算当前题目'
  );
  select * into v_session from science_v3_question_session
   where tenant_id=p_tenant_id and question_session_id=p_question_session_id
   for update;
  if not found or v_session.conversation_thread_id <> p_conversation_thread_id then
    v_rejection := 'permission_denied';
  elsif v_session.lifecycle <> 'active' then
    v_rejection := 'closed';
  elsif v_session.version <> p_expected_session_version then
    v_rejection := 'version_conflict';
  end if;

  if v_rejection is not null then
    update science_v3_operation
       set status='running',user_message='正在校验切题请求',updated_at=clock_timestamp(),version=version+1
     where tenant_id=p_tenant_id and operation_id=p_operation_id;
    insert into science_v3_operation_result (
      tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
      aggregate_version,result_resource_refs,rejection_code
    ) values (
      p_tenant_id,p_operation_id,p_idempotency_key,'rejected',
      'question-session:' || p_question_session_id,greatest(coalesce(v_session.version,1),1),
      array['question-session:' || p_question_session_id],v_rejection
    );
    update science_v3_operation
       set status='succeeded',user_message='切题请求未被接纳',retryable=false,
           related_resource_refs=array['question-session:' || p_question_session_id],
           updated_at=clock_timestamp(),version=version+1
     where tenant_id=p_tenant_id and operation_id=p_operation_id;
    return query select p_operation_id,null::text,greatest(coalesce(v_session.version,1),1),
      'rejected'::text,v_rejection;
    return;
  end if;

  select coalesce(max(session_sequence),0) into v_frozen_sequence
    from science_v3_attempt
   where tenant_id=p_tenant_id and question_session_id=p_question_session_id;
  v_new_version := v_session.version + 1;
  insert into science_v3_agent_artifact (
    artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
  ) values (
    p_artifact_id,p_tenant_id,p_operation_id,'input_bundle',
    'https://schemas.mathpilot.dev/science-v3/finalize-question-input/v1',p_payload,p_payload_sha256
  );
  insert into science_v3_cut_request (
    cut_request_id,tenant_id,conversation_thread_id,question_session_id,operation_id,
    idempotency_key,expected_session_version,frozen_attempt_sequence,reason,next_intent_ref,
    payload_ref,requested_at
  ) values (
    p_cut_request_id,p_tenant_id,p_conversation_thread_id,p_question_session_id,p_operation_id,
    p_idempotency_key,p_expected_session_version,v_frozen_sequence,p_reason,p_next_intent_ref,
    'agent-artifact:' || p_artifact_id,p_requested_at
  );
  update science_v3_question_session
     set lifecycle='finalizing',frozen_attempt_sequence=v_frozen_sequence,version=v_new_version
   where tenant_id=p_tenant_id and question_session_id=p_question_session_id;
  insert into infra_outbox (
    event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
    causation_id,occurred_at,aggregate_version,payload_ref,operation_id
  ) values (
    p_event_id,p_tenant_id,'question-session',p_question_session_id,'question.cut_requested',
    '{}'::jsonb,p_operation_id,p_idempotency_key,p_requested_at,v_new_version,
    'agent-artifact:' || p_artifact_id,p_operation_id
  );
  return query select p_operation_id,p_cut_request_id,v_new_version,'accepted'::text,null::text;
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_student', 'science_v3_conversation_thread',
    'science_v3_learning_activity', 'science_v3_selection_intent',
    'science_v3_question_session', 'science_v3_foreground_agent_epoch',
    'science_v3_canonical_message', 'science_v3_attempt',
    'science_v3_judgment', 'science_v3_observation',
    'science_v3_cut_request', 'science_v3_question_closure'
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

-- P2 installs the owning facts for Cut, so the relay may now start its
-- FinalizeQuestionWorkflow. Later phases extend only their own event types.
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
       and o.event_type in (
         'question.cut_requested', 'selection.intent_revised', 'question.closed',
         'dream.rem_requested', 'dream.deep_requested'
       )
     order by o.occurred_at, o.event_id
     limit p_limit;
end
$$;

revoke all on function mathpilot_science_v3_record_selection_intent(text,text,text,text,bigint,text,text,jsonb,text,text,timestamptz) from public;
revoke all on function mathpilot_science_v3_open_question_session(text,text,text,text,text,text,bigint,text,text,text,jsonb,text,text,text,bigint,timestamptz) from public;
revoke all on function mathpilot_science_v3_submit_attempt(text,text,text,text,text,text,text,text,bigint,text,text,jsonb,text[],integer,timestamptz) from public;
revoke all on function mathpilot_science_v3_request_cut(text,text,text,text,text,text,text,text,text,bigint,text,text,jsonb,text,timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mathpilot_app') then
    grant select,insert on science_v3_student to mathpilot_app;
    grant select,insert,update on science_v3_conversation_thread to mathpilot_app;
    grant select,insert,update on science_v3_learning_activity to mathpilot_app;
    grant select,insert on science_v3_selection_intent to mathpilot_app;
    grant select,insert,update on science_v3_question_session to mathpilot_app;
    grant select,insert,update on science_v3_foreground_agent_epoch to mathpilot_app;
    grant select,insert,update on science_v3_canonical_message to mathpilot_app;
    grant select,insert on science_v3_attempt to mathpilot_app;
    grant select,insert on science_v3_judgment to mathpilot_app;
    grant select,insert on science_v3_observation to mathpilot_app;
    grant select,insert on science_v3_cut_request to mathpilot_app;
    grant select,insert on science_v3_question_closure to mathpilot_app;
    grant execute on function mathpilot_science_v3_record_selection_intent(text,text,text,text,bigint,text,text,jsonb,text,text,timestamptz) to mathpilot_app;
    grant execute on function mathpilot_science_v3_open_question_session(text,text,text,text,text,text,bigint,text,text,text,jsonb,text,text,text,bigint,timestamptz) to mathpilot_app;
    grant execute on function mathpilot_science_v3_submit_attempt(text,text,text,text,text,text,text,text,bigint,text,text,jsonb,text[],integer,timestamptz) to mathpilot_app;
    grant execute on function mathpilot_science_v3_request_cut(text,text,text,text,text,text,text,text,text,bigint,text,text,jsonb,text,timestamptz) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0033_science_v3_question_flow');
commit;
