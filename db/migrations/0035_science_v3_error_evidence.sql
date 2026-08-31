-- 0035: science-v3 diagnostic evidence and replayable error-pattern state.
--
-- This extends only the normalized Next content and science-v3 fact model. It
-- does not read, map, backfill or provide compatibility for legacy learning,
-- misconception, profile or content tables.
begin;

create table science_v3_error_reducer_policy (
  policy_ref      text primary key check (policy_ref ~ '^error-reducer-[a-z0-9._-]+@[1-9][0-9]*$'),
  policy_id       text not null check (policy_id ~ '^error-reducer-[a-z0-9._-]+$'),
  policy_version  bigint not null check (policy_version > 0),
  effective_from  timestamptz not null,
  configuration   jsonb not null,
  created_at      timestamptz not null default now(),
  unique (policy_id,policy_version),
  check (policy_ref = policy_id || '@' || policy_version::text),
  check (jsonb_typeof(configuration) = 'object'),
  check (configuration ->> 'schema_version' = '3'),
  check (configuration ->> 'policy_type' = 'error_reducer'),
  check (configuration ->> 'policy_id' = policy_id),
  check ((configuration ->> 'policy_version')::bigint = policy_version)
);

insert into science_v3_error_reducer_policy(
  policy_ref,policy_id,policy_version,effective_from,configuration
) values (
  'error-reducer-production-v1@1','error-reducer-production-v1',1,
  '2026-08-31T00:00:00Z',
  '{
    "schema_version":3,
    "policy_type":"error_reducer",
    "policy_id":"error-reducer-production-v1",
    "policy_version":1,
    "effective_from":"2026-08-31T00:00:00Z",
    "confirmation":{
      "independent_session_supports":2,
      "decisive_requires_additional_independent_support":true
    },
    "improvement":{
      "require_prior_confirmed":true,
      "required_counter_kind":"near_transfer",
      "require_independent":true
    },
    "resolution":{
      "accepted_verification_sets":[
        ["near_transfer","far_transfer"],
        ["near_transfer","delayed_verification"]
      ]
    },
    "recurrence":{
      "from_state":"resolved",
      "minimum_support_quality":"strong",
      "target_state":"confirmed",
      "append_event":true
    },
    "exclusions":{
      "provisional":true,
      "non_discriminating":true,
      "same_question_prompted_correction":true
    },
    "supersession":{
      "exclude_replaced_facts":true,
      "full_replay":true,
      "mark_dependent_annotations_stale":true
    }
  }'::jsonb
);

create unique index content_error_cause_revision_tenant_revision_uidx
  on content_error_cause_revision(tenant_id,revision_id);
create unique index content_diagnosis_rule_revision_tenant_revision_uidx
  on content_diagnosis_rule_revision(tenant_id,revision_id);

-- Stable E identity comes from content_entity.entity_id. Revisions aggregate
-- only within that entity; ontology split/merge is an explicit supersession.
create table science_v3_error_cause_policy (
  tenant_id                    text not null references identity_tenant(tenant_id),
  error_cause_revision_id      text not null check (error_cause_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  accepted_verification_sets   jsonb not null,
  confirmed_near_due_days      integer not null check (confirmed_near_due_days between 0 and 3650),
  improving_followup_due_days  integer not null check (improving_followup_due_days between 0 and 3650),
  resolved_delayed_due_days    integer not null check (resolved_delayed_due_days between 1 and 3650),
  policy_version               bigint not null default 1 check (policy_version > 0),
  superseded_by_error_cause_revision_id text,
  published_at                 timestamptz not null default now(),
  primary key (tenant_id,error_cause_revision_id),
  foreign key (tenant_id,error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  foreign key (tenant_id,superseded_by_error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  check (jsonb_typeof(accepted_verification_sets) = 'array'
     and jsonb_array_length(accepted_verification_sets) > 0),
  check (superseded_by_error_cause_revision_id is null
      or superseded_by_error_cause_revision_id <> error_cause_revision_id)
);

create table science_v3_diagnosis_outcome_bin (
  tenant_id        text not null references identity_tenant(tenant_id),
  rule_revision_id text not null,
  outcome_bin_id   text not null check (outcome_bin_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$'),
  label             text not null check (length(label) between 1 and 500),
  quality           text not null check (quality in ('weak','strong','decisive')),
  terminal_status   text not null check (terminal_status in ('concluded','inconclusive')),
  classification_criterion text not null check (length(classification_criterion) between 1 and 2000),
  created_at        timestamptz not null default now(),
  primary key (tenant_id,rule_revision_id,outcome_bin_id),
  foreign key (tenant_id,rule_revision_id)
    references content_diagnosis_rule_revision(tenant_id,revision_id)
);

create table science_v3_diagnosis_outcome_relation (
  tenant_id                 text not null references identity_tenant(tenant_id),
  rule_revision_id          text not null,
  outcome_bin_id            text not null,
  error_cause_revision_id   text not null check (error_cause_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  relation                  text not null check (relation in ('supports','counters','non_discriminating')),
  created_at                timestamptz not null default now(),
  primary key (tenant_id,rule_revision_id,outcome_bin_id,error_cause_revision_id),
  foreign key (tenant_id,rule_revision_id,outcome_bin_id)
    references science_v3_diagnosis_outcome_bin(tenant_id,rule_revision_id,outcome_bin_id),
  foreign key (tenant_id,error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id)
);
create index science_v3_diagnosis_relation_candidate_idx
  on science_v3_diagnosis_outcome_relation(tenant_id,error_cause_revision_id,rule_revision_id);

create table science_v3_question_error_role (
  tenant_id                 text not null references identity_tenant(tenant_id),
  question_revision_id      text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  error_cause_revision_id   text not null check (error_cause_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  role                      text not null check (role in (
    'evokes','discriminates','remediates','verifies_near','verifies_far','verifies_delayed'
  )),
  paired_error_cause_revision_id text,
  created_at                timestamptz not null default now(),
  primary key (tenant_id,question_revision_id,error_cause_revision_id,role),
  foreign key (tenant_id,question_revision_id)
    references content_question_revision(tenant_id,revision_id),
  foreign key (tenant_id,error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  foreign key (tenant_id,paired_error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  check ((role='discriminates') = (paired_error_cause_revision_id is not null)),
  check (paired_error_cause_revision_id is null
      or paired_error_cause_revision_id <> error_cause_revision_id)
);
create index science_v3_question_error_role_selection_idx
  on science_v3_question_error_role(tenant_id,error_cause_revision_id,role,question_revision_id);

create table science_v3_diagnostic_claim (
  diagnostic_claim_id       text primary key check (diagnostic_claim_id ~ '^dcl_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  student_id                text not null,
  question_session_id       text not null,
  trigger_evidence_refs     text[] not null,
  active_rule_revision_id   text,
  status                    text not null check (status in ('open','concluded','inconclusive','skipped','unclassified')),
  conclusion_refs           text[] not null default '{}',
  created_at                timestamptz not null,
  closed_at                 timestamptz,
  version                   bigint not null default 1 check (version > 0),
  unique (tenant_id,diagnostic_claim_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,question_session_id)
    references science_v3_question_session(tenant_id,question_session_id),
  foreign key (tenant_id,active_rule_revision_id)
    references content_diagnosis_rule_revision(tenant_id,revision_id),
  check (cardinality(trigger_evidence_refs) between 1 and 64),
  check (cardinality(conclusion_refs) <= 64),
  check ((status='open') = (closed_at is null))
);
create index science_v3_diagnostic_claim_session_idx
  on science_v3_diagnostic_claim(tenant_id,question_session_id,status,created_at);

create table science_v3_diagnostic_claim_candidate (
  tenant_id                 text not null references identity_tenant(tenant_id),
  diagnostic_claim_id       text not null,
  position                  integer not null check (position between 0 and 7),
  error_cause_revision_id   text not null check (error_cause_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  prior_rationale           text not null check (length(prior_rationale) between 1 and 1000),
  primary key (tenant_id,diagnostic_claim_id,position),
  unique (tenant_id,diagnostic_claim_id,error_cause_revision_id),
  foreign key (tenant_id,diagnostic_claim_id)
    references science_v3_diagnostic_claim(tenant_id,diagnostic_claim_id),
  foreign key (tenant_id,error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id)
);

-- The model classifies a probe into a published bin. The host expands that
-- one immutable classification into one ErrorEvidence fact per candidate.
create table science_v3_diagnosis_outcome (
  diagnostic_outcome_id     text primary key check (diagnostic_outcome_id ~ '^dot_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  diagnostic_claim_id       text not null,
  rule_revision_id          text not null,
  outcome_bin_id            text not null,
  judgment_id               text not null,
  evidence_refs             text[] not null,
  created_at                timestamptz not null,
  supersedes_diagnostic_outcome_id text,
  fact_version              bigint not null default 1 check (fact_version > 0),
  unique (tenant_id,diagnostic_outcome_id),
  unique (tenant_id,diagnostic_claim_id,fact_version),
  foreign key (tenant_id,diagnostic_claim_id)
    references science_v3_diagnostic_claim(tenant_id,diagnostic_claim_id),
  foreign key (tenant_id,rule_revision_id,outcome_bin_id)
    references science_v3_diagnosis_outcome_bin(tenant_id,rule_revision_id,outcome_bin_id),
  foreign key (tenant_id,judgment_id)
    references science_v3_judgment(tenant_id,judgment_id),
  foreign key (tenant_id,supersedes_diagnostic_outcome_id)
    references science_v3_diagnosis_outcome(tenant_id,diagnostic_outcome_id),
  check (cardinality(evidence_refs) between 1 and 64),
  check ((supersedes_diagnostic_outcome_id is null and fact_version=1)
      or (supersedes_diagnostic_outcome_id is not null and fact_version>1))
);

create table science_v3_error_evidence (
  error_evidence_id         text primary key check (error_evidence_id ~ '^eev_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  student_id                text not null,
  error_cause_revision_id   text not null check (error_cause_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  diagnostic_claim_id       text,
  question_session_id       text not null,
  question_revision_id      text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  relation                  text not null check (relation in ('supports','counters','non_discriminating')),
  kind                      text not null check (kind in (
    'spontaneous_error','probe','self_correction','explanation','near_transfer',
    'far_transfer','delayed_verification','teacher_confirmation','teacher_correction'
  )),
  quality                   text not null check (quality in ('weak','strong','decisive')),
  independent               boolean not null,
  hint_level                integer not null check (hint_level between 0 and 5),
  eligibility               text not null check (eligibility in ('formal','provisional')),
  context_facets            jsonb not null default '{}'::jsonb,
  evidence_refs             text[] not null,
  rule_revision_id          text,
  judgment_id               text,
  model_id                  text,
  prompt_version            text,
  policy_version            text not null check (length(policy_version) between 1 and 160),
  created_at                timestamptz not null,
  supersedes_error_evidence_id text,
  fact_version              bigint not null default 1 check (fact_version > 0),
  unique (tenant_id,error_evidence_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  foreign key (tenant_id,diagnostic_claim_id)
    references science_v3_diagnostic_claim(tenant_id,diagnostic_claim_id),
  foreign key (tenant_id,question_session_id)
    references science_v3_question_session(tenant_id,question_session_id),
  foreign key (tenant_id,rule_revision_id)
    references content_diagnosis_rule_revision(tenant_id,revision_id),
  foreign key (tenant_id,judgment_id)
    references science_v3_judgment(tenant_id,judgment_id),
  foreign key (tenant_id,supersedes_error_evidence_id)
    references science_v3_error_evidence(tenant_id,error_evidence_id),
  check (jsonb_typeof(context_facets)='object' and pg_column_size(context_facets) <= 8192),
  check (cardinality(evidence_refs) between 1 and 64),
  check (model_id is null or length(model_id) between 1 and 160),
  check (prompt_version is null or length(prompt_version) between 1 and 160),
  check ((supersedes_error_evidence_id is null and fact_version=1)
      or (supersedes_error_evidence_id is not null and fact_version>1))
);
create index science_v3_error_evidence_replay_idx
  on science_v3_error_evidence(
    tenant_id,student_id,error_cause_revision_id,created_at,error_evidence_id
  );
create index science_v3_error_evidence_session_idx
  on science_v3_error_evidence(tenant_id,question_session_id,created_at,error_evidence_id);

create table science_v3_error_pattern_projection (
  tenant_id                    text not null references identity_tenant(tenant_id),
  student_id                   text not null,
  error_cause_id               text not null check (error_cause_id ~ '^E_[A-Z0-9_]{2,}$'),
  active_definition_revision_id text not null check (active_definition_revision_id ~ '^erev_[A-Za-z0-9_.:-]{4,}$'),
  state                        text not null check (state in ('suspected','confirmed','improving','resolved','superseded')),
  support_count                integer not null check (support_count >= 0),
  counter_count                integer not null check (counter_count >= 0),
  independent_session_count    integer not null check (independent_session_count >= 0),
  recurrence_count             integer not null check (recurrence_count >= 0),
  verification_due_at          timestamptz,
  effective_evidence_ids       text[] not null default '{}',
  superseded_by_error_cause_revision_id text,
  policy_version               text not null check (length(policy_version) between 1 and 160),
  projection_version           bigint not null default 1 check (projection_version > 0),
  projector_version            text not null check (length(projector_version) between 1 and 160),
  projected_at                 timestamptz not null,
  primary key (tenant_id,student_id,error_cause_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,active_definition_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  foreign key (tenant_id,superseded_by_error_cause_revision_id)
    references content_error_cause_revision(tenant_id,revision_id),
  check (cardinality(effective_evidence_ids) <= 4096),
  check ((state='superseded') = (superseded_by_error_cause_revision_id is not null))
);
create index science_v3_error_pattern_student_state_idx
  on science_v3_error_pattern_projection(tenant_id,student_id,state,verification_due_at);

create table science_v3_error_recurrence_event (
  recurrence_event_id       text primary key check (recurrence_event_id ~ '^erec_[A-Za-z0-9]{8,}$'),
  tenant_id                 text not null references identity_tenant(tenant_id),
  student_id                text not null,
  error_cause_id            text not null check (error_cause_id ~ '^E_[A-Z0-9_]{2,}$'),
  trigger_error_evidence_id text not null,
  recurrence_number         integer not null check (recurrence_number > 0),
  occurred_at               timestamptz not null,
  policy_version            text not null check (length(policy_version) between 1 and 160),
  unique (tenant_id,recurrence_event_id),
  unique (tenant_id,student_id,error_cause_id,trigger_error_evidence_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,trigger_error_evidence_id)
    references science_v3_error_evidence(tenant_id,error_evidence_id)
);

create or replace function science_v3_diagnostic_claim_guard() returns trigger as $$
begin
  if TG_OP='DELETE' then raise exception 'DiagnosticClaim cannot be deleted'; end if;
  if new.diagnostic_claim_id is distinct from old.diagnostic_claim_id
     or new.tenant_id is distinct from old.tenant_id
     or new.student_id is distinct from old.student_id
     or new.question_session_id is distinct from old.question_session_id
     or new.trigger_evidence_refs is distinct from old.trigger_evidence_refs
     or new.active_rule_revision_id is distinct from old.active_rule_revision_id
     or new.created_at is distinct from old.created_at then
    raise exception 'DiagnosticClaim frozen hypothesis space is immutable';
  end if;
  if old.status <> 'open' or new.status='open' or new.version <> old.version+1 then
    raise exception 'DiagnosticClaim can only close once with an advanced version';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_diagnostic_claim_guard
  before update or delete on science_v3_diagnostic_claim
  for each row execute function science_v3_diagnostic_claim_guard();

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_error_reducer_policy','science_v3_error_cause_policy',
    'science_v3_diagnosis_outcome_bin','science_v3_diagnosis_outcome_relation',
    'science_v3_question_error_role','science_v3_diagnostic_claim_candidate',
    'science_v3_diagnosis_outcome','science_v3_error_evidence',
    'science_v3_error_recurrence_event'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()',t || '_immutable',t);
  end loop;
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_error_cause_policy','science_v3_diagnosis_outcome_bin',
    'science_v3_diagnosis_outcome_relation','science_v3_question_error_role',
    'science_v3_diagnostic_claim','science_v3_diagnostic_claim_candidate',
    'science_v3_diagnosis_outcome','science_v3_error_evidence',
    'science_v3_error_pattern_projection','science_v3_error_recurrence_event'
  ] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id=current_setting(''app.current_tenant'',true)) with check (tenant_id=current_setting(''app.current_tenant'',true))',t
    );
  end loop;
end
$$;

create view science_v3_error_teacher_timeline with (security_invoker=true) as
select e.tenant_id,e.student_id,entity.entity_id as error_cause_id,
       e.error_cause_revision_id,cause.name as error_cause_name,e.error_evidence_id,
       e.question_session_id,e.question_revision_id,e.relation,e.kind,e.quality,
       e.independent,e.hint_level,e.eligibility,e.context_facets,e.evidence_refs,
       e.rule_revision_id,e.judgment_id,e.model_id,e.prompt_version,e.policy_version,
       e.created_at,e.supersedes_error_evidence_id,
       (
         not exists (
           select 1 from science_v3_error_evidence newer
            where newer.tenant_id=e.tenant_id
              and newer.supersedes_error_evidence_id=e.error_evidence_id
         )
         and (
           e.judgment_id is null
           or (
             not exists (
               select 1 from science_v3_judgment newer_judgment
                where newer_judgment.tenant_id=e.tenant_id
                  and newer_judgment.supersedes_judgment_id=e.judgment_id
             )
             and not exists (
               select 1
                 from science_v3_judgment source_judgment
                 join science_v3_attempt newer_attempt
                   on newer_attempt.tenant_id=source_judgment.tenant_id
                  and newer_attempt.supersedes_attempt_id=source_judgment.attempt_id
                where source_judgment.tenant_id=e.tenant_id
                  and source_judgment.judgment_id=e.judgment_id
             )
           )
         )
       ) as is_active
  from science_v3_error_evidence e
  join content_error_cause_revision cause
    on cause.tenant_id=e.tenant_id and cause.revision_id=e.error_cause_revision_id
  join content_entity_revision revision
    on revision.tenant_id=cause.tenant_id and revision.revision_id=cause.revision_id
  join content_entity entity
    on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id;

-- These are review signals, never automatic ontology writes.
create view science_v3_error_content_insight with (security_invoker=true) as
with effective_evidence as (
  select e.*
    from science_v3_error_evidence e
   where not exists (
           select 1 from science_v3_error_evidence newer
            where newer.tenant_id=e.tenant_id
              and newer.supersedes_error_evidence_id=e.error_evidence_id
         )
     and (
       e.judgment_id is null
       or (
         not exists (
           select 1 from science_v3_judgment newer_judgment
            where newer_judgment.tenant_id=e.tenant_id
              and newer_judgment.supersedes_judgment_id=e.judgment_id
         )
         and not exists (
           select 1
             from science_v3_judgment source_judgment
             join science_v3_attempt newer_attempt
               on newer_attempt.tenant_id=source_judgment.tenant_id
              and newer_attempt.supersedes_attempt_id=source_judgment.attempt_id
            where source_judgment.tenant_id=e.tenant_id
              and source_judgment.judgment_id=e.judgment_id
         )
       )
     )
)
select e.tenant_id,'repeated_error'::text as signal_type,
       entity.entity_id as error_cause_id,null::text as question_revision_id,
       null::text as rule_revision_id,count(distinct e.student_id)::integer as student_count,
       count(distinct e.question_revision_id)::integer as question_count,count(*)::integer as evidence_count
  from effective_evidence e
  join content_entity_revision revision
    on revision.tenant_id=e.tenant_id and revision.revision_id=e.error_cause_revision_id
  join content_entity entity
    on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id
 where e.eligibility='formal' and e.relation='supports'
 group by e.tenant_id,entity.entity_id
having count(distinct e.student_id)>=2 and count(distinct e.question_revision_id)>=2
union all
select e.tenant_id,'question_suspicion'::text,null::text,e.question_revision_id,null::text,
       count(distinct e.student_id)::integer,1,count(*)::integer
  from effective_evidence e
 where e.eligibility='formal' and e.relation='supports'
 group by e.tenant_id,e.question_revision_id
having count(distinct e.student_id)>=2
union all
select e.tenant_id,'weak_diagnosis_rule'::text,null::text,null::text,e.rule_revision_id,
       count(distinct e.student_id)::integer,count(distinct e.question_revision_id)::integer,count(*)::integer
  from effective_evidence e
 where e.rule_revision_id is not null and e.relation='non_discriminating'
 group by e.tenant_id,e.rule_revision_id
having count(*)>=3;

do $$
begin
  if exists(select 1 from pg_roles where rolname='mathpilot_app') then
    grant select on science_v3_error_reducer_policy to mathpilot_app;
    grant select,insert on science_v3_error_cause_policy to mathpilot_app;
    grant select,insert on science_v3_diagnosis_outcome_bin to mathpilot_app;
    grant select,insert on science_v3_diagnosis_outcome_relation to mathpilot_app;
    grant select,insert on science_v3_question_error_role to mathpilot_app;
    grant select,insert,update on science_v3_diagnostic_claim to mathpilot_app;
    grant select,insert on science_v3_diagnostic_claim_candidate to mathpilot_app;
    grant select,insert on science_v3_diagnosis_outcome to mathpilot_app;
    grant select,insert on science_v3_error_evidence to mathpilot_app;
    grant select,insert,update,delete on science_v3_error_pattern_projection to mathpilot_app;
    grant select,insert on science_v3_error_recurrence_event to mathpilot_app;
    grant select on science_v3_error_teacher_timeline to mathpilot_app;
    grant select on science_v3_error_content_insight to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0035_science_v3_error_evidence');
commit;
