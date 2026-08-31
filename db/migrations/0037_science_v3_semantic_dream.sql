-- 0037: science-v3 Light -> REM -> Deep semantic memory.
--
-- This migration creates new Next facts only. It does not read, backfill,
-- dual-write or preserve any legacy Dream/Profile snapshot or numeric update.
begin;

create table science_v3_dream_policy (
  policy_version           text primary key check (policy_version ~ '^deep-gate-v[1-9][0-9]*$'),
  light_compiler_version   text not null,
  rem_compiler_version     text not null,
  deep_compiler_version    text not null,
  minimum_sessions         jsonb not null,
  write_budget             jsonb not null,
  active                   boolean not null default false,
  created_at               timestamptz not null default now(),
  check (jsonb_typeof(minimum_sessions)='object'),
  check (jsonb_typeof(write_budget)='object')
);
create unique index science_v3_dream_policy_active_uidx
  on science_v3_dream_policy(active) where active;
insert into science_v3_dream_policy(
  policy_version,light_compiler_version,rem_compiler_version,deep_compiler_version,
  minimum_sessions,write_budget,active
) values (
  'deep-gate-v1','light-compiler-v1','rem-window-compiler-v1','deep-bundle-compiler-v1',
  '{"dimension":3,"error_cause":3,"student_trait":4}'::jsonb,
  '{"maximum_operations":8,"maximum_additions":4,"maximum_supersessions":2,"maximum_reviews":2}'::jsonb,
  true
);

create table science_v3_dream_run (
  dream_run_id       text primary key check (dream_run_id ~ '^drm_[A-Za-z0-9]{8,}$'),
  tenant_id          text not null references identity_tenant(tenant_id),
  student_id         text not null,
  operation_id       text not null,
  source_event_id    text not null,
  phase              text not null check (phase in ('light','rem','deep')),
  window_ref         text not null check (window_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  compiler_version   text not null check (length(compiler_version) between 1 and 160),
  policy_version     text not null references science_v3_dream_policy(policy_version),
  input_artifact_id  text not null,
  output_artifact_id text,
  status             text not null default 'queued' check (status in (
    'queued','running','completed','incomplete','rejected','stale','failed'
  )),
  accepted_count     integer not null default 0 check (accepted_count >= 0),
  rejected_count     integer not null default 0 check (rejected_count >= 0),
  model_id           text,
  prompt_version     text,
  skill_ref          text,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now(),
  unique (tenant_id,dream_run_id),
  unique (tenant_id,phase,window_ref,compiler_version),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,source_event_id)
    references infra_outbox(tenant_id,event_id),
  foreign key (tenant_id,input_artifact_id)
    references science_v3_agent_artifact(tenant_id,artifact_id),
  foreign key (tenant_id,output_artifact_id)
    references science_v3_agent_artifact(tenant_id,artifact_id),
  check ((status='queued')=(started_at is null)),
  check ((status in ('completed','incomplete','rejected','stale','failed'))=(finished_at is not null)),
  check (output_artifact_id is null or status not in ('queued','running'))
);
create index science_v3_dream_run_student_idx
  on science_v3_dream_run(tenant_id,student_id,phase,created_at desc);

create table science_v3_learning_evidence_atom (
  atom_id             text primary key check (atom_id ~ '^lat_[A-Za-z0-9]{8,}$'),
  tenant_id           text not null references identity_tenant(tenant_id),
  student_id          text not null,
  question_session_id text not null,
  dream_run_id        text not null,
  compiler_version    text not null,
  status              text not null check (status in ('ready','incomplete')),
  dimension_revision_ids text[] not null default '{}',
  error_cause_revision_ids text[] not null default '{}',
  observed_behaviors  text[] not null default '{}',
  method_signals      text[] not null default '{}',
  hint_dependency     text not null check (hint_dependency in ('none','low','medium','high','unknown')),
  self_correction     text not null check (self_correction in ('none','successful','partial','failed','unknown')),
  transfer_context    jsonb not null default '{}'::jsonb,
  support_refs        text[] not null default '{}',
  counter_refs        text[] not null default '{}',
  unresolved_refs     text[] not null default '{}',
  source_refs         text[] not null default '{}',
  summary             text not null check (length(summary) between 1 and 2000),
  agent_attempt_id    text not null,
  model_id            text not null,
  prompt_version      text not null,
  skill_ref           text not null,
  created_at          timestamptz not null,
  unique (tenant_id,atom_id),
  unique (tenant_id,question_session_id,compiler_version),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,question_session_id)
    references science_v3_question_session(tenant_id,question_session_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  foreign key (tenant_id,agent_attempt_id)
    references science_v3_agent_attempt(tenant_id,agent_attempt_id),
  check (jsonb_typeof(transfer_context)='object'),
  check (cardinality(dimension_revision_ids)<=32),
  check (cardinality(error_cause_revision_ids)<=32),
  check (cardinality(observed_behaviors)<=32),
  check (cardinality(method_signals)<=32),
  check (cardinality(source_refs)<=256),
  check (status='incomplete' or cardinality(source_refs)>0)
);
create index science_v3_light_atom_student_idx
  on science_v3_learning_evidence_atom(tenant_id,student_id,created_at) where status='ready';

create table science_v3_annotation_set_head (
  tenant_id  text not null references identity_tenant(tenant_id),
  student_id text not null,
  version    bigint not null default 0 check (version>=0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,student_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id)
);

create table science_v3_rem_window (
  rem_window_id         text primary key check (rem_window_id ~ '^rwin_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  student_id            text not null,
  dream_run_id          text not null,
  topic_key             text not null check (length(topic_key) between 1 and 240),
  atom_ids              text[] not null,
  annotation_set_version bigint not null check (annotation_set_version>=0),
  authorization_manifest text[] not null,
  window_opened_at      timestamptz not null,
  window_closed_at      timestamptz not null,
  context_diversity     integer not null check (context_diversity>0),
  created_at            timestamptz not null default now(),
  unique (tenant_id,rem_window_id),
  unique (tenant_id,dream_run_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  check (cardinality(atom_ids) between 1 and 64),
  check (cardinality(authorization_manifest) between 1 and 512),
  check (window_closed_at>=window_opened_at)
);
create index science_v3_rem_window_atom_idx on science_v3_rem_window using gin(atom_ids);

create table science_v3_rem_theme_candidate (
  rem_candidate_id       text primary key check (rem_candidate_id ~ '^remc_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  student_id             text not null,
  dream_run_id           text not null,
  rem_window_id          text not null,
  model_candidate_id     text not null check (model_candidate_id ~ '^remc_[A-Za-z0-9]{8,}$'),
  target_kind            text not null check (target_kind in ('dimension','error_cause','student_trait','content_insight')),
  target_ref             text not null check (target_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  proposed_claim         text not null check (length(proposed_claim) between 1 and 2000),
  proposed_scope         jsonb not null,
  support_atom_ids       text[] not null,
  counter_atom_ids       text[] not null default '{}',
  support_refs           text[] not null default '{}',
  counter_refs           text[] not null default '{}',
  contradictions        text[] not null default '{}',
  actionability          text not null check (length(actionability) between 1 and 1000),
  distinct_session_count integer not null check (distinct_session_count>0),
  context_diversity      integer not null check (context_diversity>0),
  recency                text not null check (recency in ('current','recent','historical','mixed')),
  source_trust           text not null check (source_trust in ('verified_facts','mixed','insufficient')),
  recommended_action     text not null check (recommended_action in ('hold','deep_review','collect_more','content_review')),
  created_at             timestamptz not null default now(),
  unique (tenant_id,rem_candidate_id),
  unique (tenant_id,dream_run_id,model_candidate_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  foreign key (tenant_id,rem_window_id)
    references science_v3_rem_window(tenant_id,rem_window_id),
  check (jsonb_typeof(proposed_scope)='object'),
  check (cardinality(support_atom_ids)<=64),
  check (cardinality(counter_atom_ids)<=64),
  check (cardinality(support_refs)<=256),
  check (cardinality(counter_refs)<=256)
);

create table science_v3_rem_candidate_gate (
  tenant_id          text not null references identity_tenant(tenant_id),
  rem_candidate_id   text not null,
  gate_status        text not null check (gate_status in ('accepted','rejected','review_required')),
  reasons            text[] not null,
  policy_version     text not null references science_v3_dream_policy(policy_version),
  evidence_digest    text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  primary key (tenant_id,rem_candidate_id),
  foreign key (tenant_id,rem_candidate_id)
    references science_v3_rem_theme_candidate(tenant_id,rem_candidate_id),
  check (cardinality(reasons) between 1 and 32)
);
create index science_v3_rem_gate_ready_idx
  on science_v3_rem_candidate_gate(tenant_id,created_at) where gate_status='accepted';

create table science_v3_deep_window (
  deep_window_id         text primary key check (deep_window_id ~ '^dwin_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  student_id             text not null,
  dream_run_id           text not null,
  rem_candidate_ids      text[] not null,
  expected_annotation_set_version bigint not null check (expected_annotation_set_version>=0),
  write_budget           jsonb not null,
  created_at             timestamptz not null default now(),
  unique (tenant_id,deep_window_id),
  unique (tenant_id,dream_run_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  check (cardinality(rem_candidate_ids) between 1 and 32),
  check (jsonb_typeof(write_budget)='object')
);
create index science_v3_deep_window_candidate_idx on science_v3_deep_window using gin(rem_candidate_ids);

create table science_v3_annotation_preimage (
  preimage_id            text primary key check (preimage_id ~ '^pre_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  student_id             text not null,
  annotation_set_version bigint not null check (annotation_set_version>=0),
  annotations            jsonb not null,
  sha256                 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at             timestamptz not null default now(),
  unique (tenant_id,preimage_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  check (jsonb_typeof(annotations)='array')
);

create table science_v3_annotation_change_set (
  change_set_id          text primary key check (change_set_id ~ '^acs_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  student_id             text not null,
  dream_run_id           text not null,
  operation_id           text not null,
  output_artifact_id     text not null,
  expected_set_version   bigint not null check (expected_set_version>=0),
  committed_set_version  bigint,
  status                 text not null check (status in ('committed','rejected','stale')),
  rejection_reasons      text[] not null default '{}',
  operations             jsonb not null,
  source_candidate_ids   text[] not null,
  preimage_id            text,
  diff                    jsonb not null,
  policy_version         text not null references science_v3_dream_policy(policy_version),
  agent_attempt_id       text not null,
  model_id               text not null,
  prompt_version         text not null,
  skill_ref              text not null,
  created_at             timestamptz not null,
  unique (tenant_id,change_set_id),
  unique (tenant_id,dream_run_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,output_artifact_id)
    references science_v3_agent_artifact(tenant_id,artifact_id),
  foreign key (tenant_id,preimage_id)
    references science_v3_annotation_preimage(tenant_id,preimage_id),
  foreign key (tenant_id,agent_attempt_id)
    references science_v3_agent_attempt(tenant_id,agent_attempt_id),
  check (jsonb_typeof(operations)='array'),
  check (jsonb_typeof(diff)='object'),
  check (cardinality(source_candidate_ids) between 1 and 32),
  check ((status='committed')=(committed_set_version is not null and preimage_id is not null)),
  check ((status='committed')=(cardinality(rejection_reasons)=0))
);

create table science_v3_semantic_annotation (
  annotation_id      text primary key check (annotation_id ~ '^ann_[A-Za-z0-9]{8,}$'),
  tenant_id          text not null references identity_tenant(tenant_id),
  student_id         text not null,
  set_version        bigint not null check (set_version>0),
  target_kind        text not null check (target_kind in ('dimension','error_cause','student_trait')),
  target_ref         text not null check (target_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  claim              text not null check (length(claim) between 1 and 2000),
  scope              jsonb not null,
  support_refs       text[] not null,
  counter_refs       text[] not null default '{}',
  confidence         text not null check (confidence in ('low','medium','high')),
  trend              text check (trend in ('stable','improving','worsening','mixed','unknown')),
  action_hint        text check (length(action_hint) between 1 and 1000),
  valid_from         timestamptz not null,
  review_due_at      timestamptz,
  change_set_id      text,
  dream_run_id       text,
  rollback_id        text,
  created_at         timestamptz not null default now(),
  unique (tenant_id,annotation_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,change_set_id)
    references science_v3_annotation_change_set(tenant_id,change_set_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  check (
    (change_set_id is not null and dream_run_id is not null and rollback_id is null)
    or (change_set_id is null and dream_run_id is null and rollback_id is not null)
  ),
  check (jsonb_typeof(scope)='object' and scope<>'{}'::jsonb),
  check (cardinality(support_refs) between 1 and 256),
  check (cardinality(counter_refs)<=256),
  check (review_due_at is null or review_due_at>valid_from),
  check (target_kind<>'student_trait' or review_due_at is not null)
);
create index science_v3_annotation_student_target_idx
  on science_v3_semantic_annotation(tenant_id,student_id,target_kind,target_ref,set_version desc);
create index science_v3_annotation_support_idx on science_v3_semantic_annotation using gin(support_refs);
create index science_v3_annotation_counter_idx on science_v3_semantic_annotation using gin(counter_refs);

create table science_v3_annotation_supersession (
  annotation_supersession_id text primary key check (annotation_supersession_id ~ '^asup_[A-Za-z0-9]{8,}$'),
  tenant_id               text not null references identity_tenant(tenant_id),
  student_id              text not null,
  superseded_annotation_id text not null,
  replacement_annotation_id text,
  actor_kind              text not null check (actor_kind in ('deep','rollback','teacher_correction','privacy')),
  change_set_id           text,
  rollback_id             text,
  reason                  text not null check (length(reason) between 1 and 1000),
  created_at              timestamptz not null default now(),
  unique (tenant_id,annotation_supersession_id),
  unique (tenant_id,superseded_annotation_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,superseded_annotation_id)
    references science_v3_semantic_annotation(tenant_id,annotation_id),
  foreign key (tenant_id,replacement_annotation_id)
    references science_v3_semantic_annotation(tenant_id,annotation_id),
  foreign key (tenant_id,change_set_id)
    references science_v3_annotation_change_set(tenant_id,change_set_id),
  check ((actor_kind='deep')=(change_set_id is not null)),
  check (actor_kind='deep' or replacement_annotation_id is null or rollback_id is not null)
);

create table science_v3_annotation_stale_fact (
  annotation_stale_id text primary key check (annotation_stale_id ~ '^ast_[A-Za-z0-9]{8,}$'),
  tenant_id           text not null references identity_tenant(tenant_id),
  student_id          text not null,
  annotation_id       text not null,
  caused_by_ref       text not null check (caused_by_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  reason              text not null check (length(reason) between 1 and 1000),
  created_at          timestamptz not null default now(),
  unique (tenant_id,annotation_stale_id),
  unique (tenant_id,annotation_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,annotation_id)
    references science_v3_semantic_annotation(tenant_id,annotation_id)
);

create table science_v3_annotation_review_proposal (
  review_proposal_id text primary key check (review_proposal_id ~ '^arv_[A-Za-z0-9]{8,}$'),
  tenant_id          text not null references identity_tenant(tenant_id),
  student_id         text not null,
  dream_run_id       text not null,
  change_set_id      text,
  target_kind        text not null check (target_kind in ('student_trait','content_insight','annotation')),
  target_ref         text not null check (target_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  reason             text not null check (length(reason) between 1 and 2000),
  support_refs       text[] not null,
  counter_refs       text[] not null default '{}',
  status             text not null default 'pending' check (status='pending'),
  created_at         timestamptz not null default now(),
  unique (tenant_id,review_proposal_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  foreign key (tenant_id,change_set_id)
    references science_v3_annotation_change_set(tenant_id,change_set_id),
  check (cardinality(support_refs) between 1 and 256),
  check (cardinality(counter_refs)<=256)
);

create table science_v3_dream_diary_entry (
  diary_entry_id   text primary key check (diary_entry_id ~ '^dia_[A-Za-z0-9]{8,}$'),
  tenant_id        text not null references identity_tenant(tenant_id),
  student_id       text not null,
  dream_run_id     text not null,
  phase            text not null check (phase in ('light','rem','deep')),
  status           text not null check (status in ('completed','incomplete','rejected','stale','failed')),
  input_refs       text[] not null,
  accepted_count   integer not null default 0 check (accepted_count>=0),
  rejected_count   integer not null default 0 check (rejected_count>=0),
  rejection_reasons text[] not null default '{}',
  summary          text not null check (length(summary) between 1 and 2000),
  preimage_ref     text,
  model_id         text,
  prompt_version   text,
  skill_ref        text,
  started_at       timestamptz,
  finished_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  unique (tenant_id,diary_entry_id),
  unique (tenant_id,dream_run_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,dream_run_id)
    references science_v3_dream_run(tenant_id,dream_run_id),
  check (cardinality(input_refs) between 1 and 512),
  check (cardinality(rejection_reasons)<=64),
  check (preimage_ref is null or preimage_ref ~ '^annotation-preimage:pre_[A-Za-z0-9]{8,}$')
);

create table science_v3_annotation_rollback (
  rollback_id       text primary key check (rollback_id ~ '^arb_[A-Za-z0-9]{8,}$'),
  tenant_id         text not null references identity_tenant(tenant_id),
  student_id        text not null,
  change_set_id     text not null,
  preimage_id       text not null,
  actor_user_id     text not null references identity_user(user_id),
  reason            text not null check (length(reason) between 1 and 1000),
  from_set_version  bigint not null check (from_set_version>=0),
  to_set_version    bigint not null check (to_set_version>from_set_version),
  restored_annotation_ids text[] not null default '{}',
  retired_annotation_ids text[] not null default '{}',
  created_at        timestamptz not null default now(),
  unique (tenant_id,rollback_id),
  unique (tenant_id,change_set_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,change_set_id)
    references science_v3_annotation_change_set(tenant_id,change_set_id),
  foreign key (tenant_id,preimage_id)
    references science_v3_annotation_preimage(tenant_id,preimage_id),
  check (cardinality(restored_annotation_ids)<=50),
  check (cardinality(retired_annotation_ids)<=50)
);

alter table science_v3_annotation_supersession
  add constraint science_v3_annotation_supersession_rollback_fk
  foreign key (tenant_id,rollback_id)
  references science_v3_annotation_rollback(tenant_id,rollback_id)
  deferrable initially deferred;

alter table science_v3_semantic_annotation
  add constraint science_v3_semantic_annotation_rollback_fk
  foreign key (tenant_id,rollback_id)
  references science_v3_annotation_rollback(tenant_id,rollback_id);

create table science_v3_annotation_feedback (
  annotation_feedback_id text primary key check (annotation_feedback_id ~ '^afb_[A-Za-z0-9]{8,}$'),
  tenant_id         text not null references identity_tenant(tenant_id),
  student_id        text not null,
  annotation_id     text not null,
  actor_user_id     text not null references identity_user(user_id),
  feedback          text not null check (feedback in ('accurate','inaccurate','not_useful','sensitive','needs_review')),
  note              text check (length(note) between 1 and 2000),
  created_at        timestamptz not null default now(),
  unique (tenant_id,annotation_feedback_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,annotation_id)
    references science_v3_semantic_annotation(tenant_id,annotation_id)
);

create table science_v3_annotation_usage_preference_event (
  preference_event_id text primary key check (preference_event_id ~ '^aup_[A-Za-z0-9]{8,}$'),
  tenant_id         text not null references identity_tenant(tenant_id),
  student_id        text not null,
  actor_user_id     text not null references identity_user(user_id),
  annotation_id     text,
  enabled           boolean not null,
  reason            text check (length(reason) between 1 and 1000),
  created_at        timestamptz not null default now(),
  unique (tenant_id,preference_event_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,annotation_id)
    references science_v3_semantic_annotation(tenant_id,annotation_id)
);
create index science_v3_annotation_preference_latest_idx
  on science_v3_annotation_usage_preference_event(tenant_id,student_id,annotation_id,created_at desc);

create or replace function science_v3_dream_run_guard() returns trigger as $$
begin
  if TG_OP='DELETE' then raise exception 'science-v3 DreamRun cannot be deleted'; end if;
  if row(NEW.dream_run_id,NEW.tenant_id,NEW.student_id,NEW.operation_id,NEW.source_event_id,
         NEW.phase,NEW.window_ref,NEW.compiler_version,NEW.policy_version,NEW.input_artifact_id,NEW.created_at)
     is distinct from
     row(OLD.dream_run_id,OLD.tenant_id,OLD.student_id,OLD.operation_id,OLD.source_event_id,
         OLD.phase,OLD.window_ref,OLD.compiler_version,OLD.policy_version,OLD.input_artifact_id,OLD.created_at) then
    raise exception 'science-v3 DreamRun identity and input are immutable';
  end if;
  if OLD.status in ('completed','incomplete','rejected','stale','failed') then
    raise exception 'terminal science-v3 DreamRun is immutable';
  end if;
  if OLD.status='queued' and NEW.status not in ('running','failed')
     or OLD.status='running' and NEW.status not in ('completed','incomplete','rejected','stale','failed') then
    raise exception 'invalid science-v3 DreamRun status transition';
  end if;
  return NEW;
end
$$ language plpgsql;
create trigger science_v3_dream_run_guard
  before update or delete on science_v3_dream_run
  for each row execute function science_v3_dream_run_guard();

create or replace function science_v3_annotation_head_guard() returns trigger as $$
begin
  if TG_OP='DELETE' then raise exception 'science-v3 Annotation head cannot be deleted'; end if;
  if NEW.tenant_id<>OLD.tenant_id or NEW.student_id<>OLD.student_id
     or NEW.version<>OLD.version+1 or NEW.updated_at<=OLD.updated_at then
    raise exception 'science-v3 Annotation head must advance exactly one version';
  end if;
  return NEW;
end
$$ language plpgsql;
create trigger science_v3_annotation_head_guard
  before update or delete on science_v3_annotation_set_head
  for each row execute function science_v3_annotation_head_guard();

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_dream_run','science_v3_learning_evidence_atom','science_v3_annotation_set_head',
    'science_v3_rem_window','science_v3_rem_theme_candidate','science_v3_rem_candidate_gate',
    'science_v3_deep_window','science_v3_annotation_preimage','science_v3_annotation_change_set',
    'science_v3_semantic_annotation','science_v3_annotation_supersession','science_v3_annotation_stale_fact',
    'science_v3_annotation_review_proposal','science_v3_dream_diary_entry','science_v3_annotation_rollback',
    'science_v3_annotation_feedback','science_v3_annotation_usage_preference_event'
  ] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id=current_setting(''app.current_tenant'',true)) with check (tenant_id=current_setting(''app.current_tenant'',true))',t
    );
  end loop;
  foreach t in array array[
    'science_v3_learning_evidence_atom','science_v3_rem_window','science_v3_rem_theme_candidate',
    'science_v3_rem_candidate_gate','science_v3_deep_window','science_v3_annotation_preimage',
    'science_v3_annotation_change_set','science_v3_semantic_annotation','science_v3_annotation_supersession',
    'science_v3_annotation_stale_fact','science_v3_annotation_review_proposal','science_v3_dream_diary_entry',
    'science_v3_annotation_rollback','science_v3_annotation_feedback','science_v3_annotation_usage_preference_event'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()',t || '_immutable',t);
  end loop;
end
$$;

do $$
begin
  if exists(select 1 from pg_roles where rolname='mathpilot_app') then
    grant select on science_v3_dream_policy to mathpilot_app;
    grant select,insert,update on science_v3_dream_run to mathpilot_app;
    grant select,insert on science_v3_learning_evidence_atom to mathpilot_app;
    grant select,insert,update on science_v3_annotation_set_head to mathpilot_app;
    grant select,insert on science_v3_rem_window to mathpilot_app;
    grant select,insert on science_v3_rem_theme_candidate to mathpilot_app;
    grant select,insert on science_v3_rem_candidate_gate to mathpilot_app;
    grant select,insert on science_v3_deep_window to mathpilot_app;
    grant select,insert on science_v3_annotation_preimage to mathpilot_app;
    grant select,insert on science_v3_annotation_change_set to mathpilot_app;
    grant select,insert on science_v3_semantic_annotation to mathpilot_app;
    grant select,insert on science_v3_annotation_supersession to mathpilot_app;
    grant select,insert on science_v3_annotation_stale_fact to mathpilot_app;
    grant select,insert on science_v3_annotation_review_proposal to mathpilot_app;
    grant select,insert on science_v3_dream_diary_entry to mathpilot_app;
    grant select,insert on science_v3_annotation_rollback to mathpilot_app;
    grant select,insert on science_v3_annotation_feedback to mathpilot_app;
    grant select,insert on science_v3_annotation_usage_preference_event to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0037_science_v3_semantic_dream');
commit;
