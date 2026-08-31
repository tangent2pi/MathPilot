-- 0034: science-v3 deterministic evidence compiler and M/R projections.
--
-- All scientific state below is derived from 0033 immutable facts. This
-- migration neither reads nor writes legacy mastery/profile/review tables and
-- deliberately provides no compatibility or backfill path.
begin;

create table science_v3_evidence_policy (
  policy_ref       text primary key check (policy_ref ~ '^evidence-policy-[a-z0-9._-]+@[1-9][0-9]*$'),
  policy_id        text not null check (policy_id ~ '^evidence-policy-[a-z0-9._-]+$'),
  policy_version   bigint not null check (policy_version > 0),
  effective_from   timestamptz not null,
  configuration    jsonb not null,
  created_at       timestamptz not null default now(),
  unique (policy_id, policy_version),
  check (policy_ref = policy_id || '@' || policy_version::text),
  check (jsonb_typeof(configuration) = 'object'),
  check (configuration ->> 'schema_version' = '3'),
  check (configuration ->> 'policy_type' = 'evidence'),
  check (configuration ->> 'policy_id' = policy_id),
  check ((configuration ->> 'policy_version')::bigint = policy_version)
);

insert into science_v3_evidence_policy (
  policy_ref,policy_id,policy_version,effective_from,configuration
) values (
  'evidence-policy-production-v1@1',
  'evidence-policy-production-v1',
  1,
  '2026-08-31T00:00:00Z',
  '{
    "schema_version":3,
    "policy_type":"evidence",
    "policy_id":"evidence-policy-production-v1",
    "policy_version":1,
    "effective_from":"2026-08-31T00:00:00Z",
    "independent_measurement":{
      "required_hint_level":0,
      "require_frozen_question_revision":true,
      "require_reliable_rubric":true,
      "reject_same_question_correction":true,
      "reject_prior_solution_exposure":true,
      "exclude_superseded":true
    },
    "delayed_review":{
      "minimum_delay_minutes":1440,
      "success_rating":"good",
      "failure_rating":"again",
      "allow_hard":false,
      "allow_easy":false
    },
    "external_content":{
      "unverified_measurement":"reject",
      "unverified_error_evidence":"provisional_only"
    },
    "supersession":{
      "append_only":true,
      "replay_required":true,
      "idempotent":true
    }
  }'::jsonb
);

create table science_v3_mastery_parameter_set (
  parameter_set_id   text primary key check (length(parameter_set_id) between 1 and 160),
  engine             text not null check (engine = 'oatutor-bkt-brain'),
  engine_version     text not null check (length(engine_version) between 1 and 160),
  parameters         jsonb not null,
  calibration_status text not null check (calibration_status in ('prior_only','calibrated')),
  state_thresholds   jsonb not null,
  effective_from     timestamptz not null,
  created_at         timestamptz not null default now(),
  check (jsonb_typeof(parameters) = 'object'),
  check (parameters ?& array['prior','learn','slip','guess']),
  check (jsonb_typeof(state_thresholds) = 'object'),
  check (state_thresholds ?& array['minimum_independent_count','weak','learning','mastered'])
);

insert into science_v3_mastery_parameter_set (
  parameter_set_id,engine,engine_version,parameters,calibration_status,state_thresholds,effective_from
) values (
  'bkt-oatutor-prior-v1',
  'oatutor-bkt-brain',
  'CAHLR/OATutor@6c729b7192c084367348b87486f70846463e3902',
  '{"prior":0.3,"learn":0.0,"slip":0.1,"guess":0.2}'::jsonb,
  'prior_only',
  '{"minimum_independent_count":2,"weak":0.4,"learning":0.8,"mastered":0.95}'::jsonb,
  '2026-08-31T00:00:00Z'
);

create table science_v3_retention_parameter_set (
  parameter_set_id text primary key check (length(parameter_set_id) between 1 and 160),
  engine           text not null check (engine = 'ts-fsrs'),
  engine_version   text not null check (engine_version = '5.4.1'),
  parameters       jsonb not null,
  effective_from   timestamptz not null,
  created_at       timestamptz not null default now(),
  check (jsonb_typeof(parameters) = 'object'),
  check (parameters ?& array[
    'request_retention','maximum_interval','w','enable_fuzz','enable_short_term',
    'learning_steps','relearning_steps'
  ]),
  check (parameters ->> 'enable_fuzz' = 'false')
);

insert into science_v3_retention_parameter_set (
  parameter_set_id,engine,engine_version,parameters,effective_from
) values (
  'fsrs-5.4.1-default-v1',
  'ts-fsrs',
  '5.4.1',
  '{
    "request_retention":0.9,
    "maximum_interval":36500,
    "w":[0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542],
    "enable_fuzz":false,
    "enable_short_term":false,
    "learning_steps":[],
    "relearning_steps":[]
  }'::jsonb,
  '2026-08-31T00:00:00Z'
);

-- A missing compatibility declaration is conservative: the projector treats
-- that content revision as its own lineage version. Rows here are explicit
-- approvals to aggregate semantically compatible revisions.
create unique index content_entity_revision_tenant_revision_uidx
  on content_entity_revision (tenant_id, revision_id);
create table science_v3_dimension_lineage (
  tenant_id             text not null references identity_tenant(tenant_id),
  dimension_revision_id text not null,
  dimension_id          text not null check (dimension_id ~ '^(K|T)_[A-Z0-9_]{2,}$'),
  lineage_version       bigint not null check (lineage_version > 0),
  approved_at           timestamptz not null default now(),
  primary key (tenant_id, dimension_revision_id),
  foreign key (tenant_id, dimension_revision_id)
    references content_entity_revision(tenant_id, revision_id)
);

create table science_v3_retention_unit_revision (
  retention_unit_revision_id text primary key check (retention_unit_revision_id ~ '^rurev_[A-Za-z0-9_.:-]{4,}$'),
  tenant_id                   text not null references identity_tenant(tenant_id),
  dimension_revision_id       text not null,
  scope_facets                jsonb not null default '{}'::jsonb,
  definition_version          bigint not null default 1 check (definition_version > 0),
  created_at                  timestamptz not null default now(),
  unique (tenant_id, retention_unit_revision_id),
  foreign key (tenant_id, dimension_revision_id)
    references content_entity_revision(tenant_id, revision_id),
  check (jsonb_typeof(scope_facets) = 'object'),
  check (pg_column_size(scope_facets) <= 8192)
);

create unique index content_question_measurement_target_tenant_item_uidx
  on content_question_measurement_target (tenant_id, item_id);
create table science_v3_retention_unit_measurement_rule (
  tenant_id                   text not null references identity_tenant(tenant_id),
  question_revision_id        text not null,
  measurement_rule_id         text not null,
  retention_unit_revision_id  text not null,
  created_at                  timestamptz not null default now(),
  primary key (tenant_id, question_revision_id, measurement_rule_id),
  foreign key (tenant_id, question_revision_id)
    references content_question_revision(tenant_id, revision_id),
  foreign key (tenant_id, measurement_rule_id)
    references content_question_measurement_target(tenant_id, item_id),
  foreign key (tenant_id, retention_unit_revision_id)
    references science_v3_retention_unit_revision(tenant_id, retention_unit_revision_id)
);

create table science_v3_learning_opportunity (
  learning_opportunity_id text primary key check (learning_opportunity_id ~ '^lop_[A-Za-z0-9]{8,}$'),
  tenant_id                text not null references identity_tenant(tenant_id),
  student_id               text not null,
  judgment_id              text not null,
  dimension_revision_ids   text[] not null,
  question_session_id      text not null,
  intervention_kind        text not null check (intervention_kind in (
    'hint','explanation','worked_example','self_correction','guided_completion'
  )),
  hint_level               integer not null check (hint_level between 1 and 5),
  evidence_refs            text[] not null,
  occurred_at              timestamptz not null,
  fact_version             bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, learning_opportunity_id),
  unique (tenant_id, judgment_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, judgment_id)
    references science_v3_judgment(tenant_id, judgment_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  check (cardinality(dimension_revision_ids) between 1 and 32),
  check (cardinality(evidence_refs) between 1 and 64)
);

create table science_v3_evidence_rejection (
  rejection_id          text primary key check (rejection_id ~ '^rej_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  judgment_id           text not null,
  attempt_id            text not null,
  dimension_revision_id text,
  rejection_code        text not null check (rejection_code in (
    'policy_mismatch','unverified_content','unresolved_judgment','high_uncertainty',
    'non_independent_attempt','hint_present','missing_measurement_target',
    'ambiguous_measurement_rule','unreliable_rubric','unresolved_dimension'
  )),
  policy_version        text not null,
  detail                text not null check (length(detail) between 1 and 1000),
  created_at            timestamptz not null default now(),
  unique (tenant_id, rejection_id),
  foreign key (tenant_id, judgment_id)
    references science_v3_judgment(tenant_id, judgment_id),
  foreign key (tenant_id, attempt_id)
    references science_v3_attempt(tenant_id, attempt_id)
);
create index science_v3_evidence_rejection_judgment_idx
  on science_v3_evidence_rejection (tenant_id, judgment_id, rejection_code);

create table science_v3_delayed_review_event (
  delayed_review_event_id text primary key check (delayed_review_event_id ~ '^drv_[A-Za-z0-9]{8,}$'),
  tenant_id                text not null references identity_tenant(tenant_id),
  student_id               text not null,
  retention_unit_revision_id text not null,
  observation_id           text not null,
  previous_observation_id  text,
  previous_learning_opportunity_id text,
  rating                   text not null check (rating in ('again','good')),
  elapsed_days             numeric not null check (elapsed_days > 0),
  independent             boolean not null default true check (independent),
  occurred_at              timestamptz not null,
  policy_version           text not null,
  supersedes_delayed_review_event_id text,
  fact_version             bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, delayed_review_event_id),
  unique (tenant_id, observation_id, retention_unit_revision_id, fact_version),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, retention_unit_revision_id)
    references science_v3_retention_unit_revision(tenant_id, retention_unit_revision_id),
  foreign key (tenant_id, observation_id)
    references science_v3_observation(tenant_id, observation_id),
  foreign key (tenant_id, previous_observation_id)
    references science_v3_observation(tenant_id, observation_id),
  foreign key (tenant_id, previous_learning_opportunity_id)
    references science_v3_learning_opportunity(tenant_id, learning_opportunity_id),
  foreign key (tenant_id, supersedes_delayed_review_event_id)
    references science_v3_delayed_review_event(tenant_id, delayed_review_event_id),
  check ((previous_observation_id is not null)::integer
       + (previous_learning_opportunity_id is not null)::integer = 1),
  check (previous_observation_id is null or observation_id <> previous_observation_id),
  check ((supersedes_delayed_review_event_id is null and fact_version = 1)
      or (supersedes_delayed_review_event_id is not null and fact_version > 1))
);
create index science_v3_delayed_review_replay_idx
  on science_v3_delayed_review_event (
    tenant_id,student_id,retention_unit_revision_id,occurred_at,delayed_review_event_id
  );

create table science_v3_mastery_projection (
  tenant_id             text not null references identity_tenant(tenant_id),
  student_id            text not null,
  dimension_id          text not null check (dimension_id ~ '^(K|T)_[A-Z0-9_]{2,}$'),
  lineage_version       bigint not null check (lineage_version > 0),
  p_mastery             numeric not null check (p_mastery between 0 and 1),
  state                 text not null check (state in (
    'insufficient_evidence','weak','learning','possibly_mastered','mastered'
  )),
  independent_count     integer not null check (independent_count >= 0),
  transfer_evidence     integer not null check (transfer_evidence >= 0),
  parameter_set_id      text not null references science_v3_mastery_parameter_set(parameter_set_id),
  calibration_status    text not null check (calibration_status in ('prior_only','calibrated')),
  input_observation_ids text[] not null,
  projection_version    bigint not null check (projection_version > 0),
  projector_version     text not null,
  projected_at          timestamptz not null,
  primary key (tenant_id,student_id,dimension_id,lineage_version),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  check (cardinality(input_observation_ids) = independent_count)
);

create table science_v3_retention_projection (
  tenant_id                     text not null references identity_tenant(tenant_id),
  student_id                    text not null,
  retention_unit_revision_id    text not null,
  dimension_revision_id         text not null,
  scope_facets                  jsonb not null,
  due_at                        timestamptz not null,
  stability                     numeric not null check (stability > 0),
  difficulty                    numeric not null check (difficulty between 1 and 10),
  retrievability                numeric not null check (retrievability between 0 and 1),
  card_state                    text not null check (card_state in ('new','learning','review','relearning')),
  fsrs_card                     jsonb not null,
  last_review_event_id          text not null,
  review_count                  integer not null check (review_count > 0),
  parameter_set_id              text not null references science_v3_retention_parameter_set(parameter_set_id),
  input_review_event_ids        text[] not null,
  projection_version            bigint not null check (projection_version > 0),
  projector_version             text not null,
  projected_at                  timestamptz not null,
  primary key (tenant_id,student_id,retention_unit_revision_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, retention_unit_revision_id)
    references science_v3_retention_unit_revision(tenant_id, retention_unit_revision_id),
  foreign key (tenant_id, last_review_event_id)
    references science_v3_delayed_review_event(tenant_id, delayed_review_event_id),
  check (jsonb_typeof(scope_facets) = 'object'),
  check (jsonb_typeof(fsrs_card) = 'object'),
  check (cardinality(input_review_event_ids) = review_count)
);

create table science_v3_teacher_correction (
  teacher_correction_id  text primary key check (teacher_correction_id ~ '^tcor_[A-Za-z0-9]{8,}$'),
  tenant_id              text not null references identity_tenant(tenant_id),
  operation_id           text not null,
  teacher_user_id        text not null references identity_user(user_id),
  student_id             text not null,
  question_session_id    text not null,
  target_judgment_id     text not null,
  replacement_judgment_id text not null,
  idempotency_key        text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  reason                 text not null check (length(reason) between 1 and 2000),
  requested_at           timestamptz not null,
  fact_version           bigint not null check (fact_version > 1),
  unique (tenant_id, teacher_correction_id),
  unique (tenant_id, operation_id),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, target_judgment_id),
  unique (tenant_id, replacement_judgment_id),
  foreign key (tenant_id, operation_id)
    references science_v3_operation(tenant_id, operation_id),
  foreign key (tenant_id, student_id)
    references science_v3_student(tenant_id, student_id),
  foreign key (tenant_id, question_session_id)
    references science_v3_question_session(tenant_id, question_session_id),
  foreign key (tenant_id, target_judgment_id)
    references science_v3_judgment(tenant_id, judgment_id),
  foreign key (tenant_id, replacement_judgment_id)
    references science_v3_judgment(tenant_id, judgment_id)
);

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_evidence_policy','science_v3_mastery_parameter_set',
    'science_v3_retention_parameter_set','science_v3_dimension_lineage',
    'science_v3_retention_unit_revision','science_v3_retention_unit_measurement_rule',
    'science_v3_learning_opportunity','science_v3_evidence_rejection',
    'science_v3_delayed_review_event','science_v3_teacher_correction'
  ] loop
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()', t || '_immutable', t);
  end loop;
end
$$;

create or replace function science_v3_projection_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then return old; end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.student_id is distinct from old.student_id
     or (TG_TABLE_NAME = 'science_v3_mastery_projection' and (
       to_jsonb(new) ->> 'dimension_id' is distinct from to_jsonb(old) ->> 'dimension_id'
       or to_jsonb(new) ->> 'lineage_version' is distinct from to_jsonb(old) ->> 'lineage_version'
     ))
     or (TG_TABLE_NAME = 'science_v3_retention_projection' and
       to_jsonb(new) ->> 'retention_unit_revision_id' is distinct from to_jsonb(old) ->> 'retention_unit_revision_id')
     or new.projection_version <> old.projection_version + 1 then
    raise exception 'scientific projection identity is immutable and version must advance once';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_mastery_projection_guard
  before update or delete on science_v3_mastery_projection
  for each row execute function science_v3_projection_guard();
create trigger science_v3_retention_projection_guard
  before update or delete on science_v3_retention_projection
  for each row execute function science_v3_projection_guard();

create or replace function mathpilot_science_v3_record_teacher_correction(
  p_tenant_id text,
  p_teacher_correction_id text,
  p_operation_id text,
  p_event_id text,
  p_idempotency_key text,
  p_teacher_user_id text,
  p_target_judgment_id text,
  p_replacement_judgment_id text,
  p_verdict text,
  p_rubric_results jsonb,
  p_dimension_proposals jsonb,
  p_uncertainty text,
  p_decision_summary text,
  p_evidence_refs text[],
  p_reason text,
  p_requested_at timestamptz
) returns table (
  operation_id text,
  teacher_correction_id text,
  aggregate_version bigint,
  status text
)
language plpgsql
as $$
declare
  v_target science_v3_judgment%rowtype;
  v_attempt science_v3_attempt%rowtype;
  v_session science_v3_question_session%rowtype;
  v_existing science_v3_teacher_correction%rowtype;
  v_version bigint;
begin
  if current_setting('app.current_tenant', true) is distinct from p_tenant_id
     or current_setting('app.current_user', true) is distinct from p_teacher_user_id then
    raise exception 'teacher correction requester context mismatch';
  end if;
  if not exists (
    select 1 from identity_user_role
     where tenant_id=p_tenant_id and user_id=p_teacher_user_id and role='teacher'
  ) then
    raise exception 'teacher role required';
  end if;

  select * into v_existing from science_v3_teacher_correction
   where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    return query select v_existing.operation_id,v_existing.teacher_correction_id,
                        v_existing.fact_version,'accepted'::text;
    return;
  end if;

  select * into v_target from science_v3_judgment
   where tenant_id=p_tenant_id and judgment_id=p_target_judgment_id
     and not exists (
       select 1 from science_v3_judgment newer
        where newer.tenant_id=p_tenant_id
          and newer.supersedes_judgment_id=p_target_judgment_id
     );
  if not found then raise exception 'target Judgment is not active'; end if;
  select * into v_attempt from science_v3_attempt
   where tenant_id=p_tenant_id and attempt_id=v_target.attempt_id;
  select * into v_session from science_v3_question_session
   where tenant_id=p_tenant_id and question_session_id=v_attempt.question_session_id;
  if not found or v_session.lifecycle not in ('closed','abandoned') then
    raise exception 'teacher correction requires a closed QuestionSession';
  end if;
  if p_verdict not in ('correct','partially_correct','incorrect','unresolved')
     or p_uncertainty not in ('low','medium','high')
     or jsonb_typeof(p_rubric_results) <> 'array'
     or jsonb_array_length(p_rubric_results) = 0
     or jsonb_typeof(p_dimension_proposals) <> 'array'
     or cardinality(p_evidence_refs) < 1 then
    raise exception 'invalid replacement Judgment';
  end if;
  if exists (
    select 1 from unnest(p_evidence_refs) ref
     where not (ref = any(v_attempt.content_refs))
  ) then
    raise exception 'teacher correction cites evidence outside the frozen Attempt';
  end if;
  if cardinality(p_evidence_refs) <> (
    select count(distinct ref) from unnest(p_evidence_refs) ref
  ) then
    raise exception 'teacher correction evidence refs must be unique';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rubric_results) rubric
     where jsonb_typeof(rubric) <> 'object'
        or not (rubric ?& array['rubric_item_id','status','evidence_refs'])
        or rubric ->> 'status' not in ('met','not_met','unclear')
        or jsonb_typeof(rubric -> 'evidence_refs') <> 'array'
        or jsonb_array_length(rubric -> 'evidence_refs') = 0
  ) or jsonb_array_length(p_rubric_results) <> (
    select count(distinct rubric ->> 'rubric_item_id')
      from jsonb_array_elements(p_rubric_results) rubric
  ) then
    raise exception 'teacher correction rubric results are invalid or duplicated';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_rubric_results) rubric
      cross join lateral jsonb_array_elements(rubric -> 'evidence_refs') evidence
     where jsonb_typeof(evidence) <> 'string'
        or not ((evidence #>> '{}') = any(v_attempt.content_refs))
  ) then
    raise exception 'teacher correction rubric cites evidence outside the frozen Attempt';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_dimension_proposals) proposal
     where jsonb_typeof(proposal) <> 'object'
        or not (proposal ?& array['dimension_revision_id','rubric_item_id','outcome'])
        or proposal ->> 'outcome' not in ('success','failure','unresolved')
        or not exists (
          select 1
            from jsonb_array_elements_text(v_session.frozen_measurement_contract -> 'dimension_revision_ids') dimension(value)
           where dimension.value = proposal ->> 'dimension_revision_id'
        )
        or not exists (
          select 1 from jsonb_array_elements(p_rubric_results) rubric
           where rubric ->> 'rubric_item_id' = proposal ->> 'rubric_item_id'
             and (
               (proposal ->> 'outcome' = 'success' and rubric ->> 'status' = 'met')
               or (proposal ->> 'outcome' = 'failure' and rubric ->> 'status' = 'not_met')
               or (proposal ->> 'outcome' = 'unresolved' and rubric ->> 'status' = 'unclear')
             )
        )
  ) or jsonb_array_length(p_dimension_proposals) <> (
    select count(distinct proposal ->> 'dimension_revision_id')
      from jsonb_array_elements(p_dimension_proposals) proposal
  ) then
    raise exception 'teacher correction dimension proposals contradict frozen rubric facts';
  end if;

  v_version := v_target.fact_version + 1;
  insert into science_v3_operation (
    operation_id,tenant_id,requested_by_user_id,kind,status,user_message,
    related_resource_refs,retryable,started_at,updated_at,version
  ) values (
    p_operation_id,p_tenant_id,p_teacher_user_id,'teacher_correction','accepted',
    '教师纠正已记录，正在重放科学状态',
    array['judgment:' || p_replacement_judgment_id],true,p_requested_at,p_requested_at,1
  );
  insert into science_v3_judgment (
    judgment_id,tenant_id,attempt_id,verdict,rubric_results,dimension_proposals,
    uncertainty,decision_summary,evidence_refs,model_id,prompt_version,skill_version,
    created_at,supersedes_judgment_id,fact_version
  ) values (
    p_replacement_judgment_id,p_tenant_id,v_attempt.attempt_id,p_verdict,
    p_rubric_results,p_dimension_proposals,p_uncertainty,p_decision_summary,
    p_evidence_refs,'teacher:' || p_teacher_user_id,'teacher-correction-v1','human-review@v1',
    p_requested_at,p_target_judgment_id,v_version
  );
  insert into science_v3_teacher_correction (
    teacher_correction_id,tenant_id,operation_id,teacher_user_id,student_id,
    question_session_id,target_judgment_id,replacement_judgment_id,idempotency_key,
    reason,requested_at,fact_version
  ) values (
    p_teacher_correction_id,p_tenant_id,p_operation_id,p_teacher_user_id,v_session.student_id,
    v_session.question_session_id,p_target_judgment_id,p_replacement_judgment_id,
    p_idempotency_key,p_reason,p_requested_at,v_version
  );
  insert into infra_outbox (
    event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,
    correlation_id,causation_id,occurred_at,aggregate_version,payload_ref,operation_id
  ) values (
    p_event_id,p_tenant_id,'student',v_session.student_id,'teacher.correction_recorded','{}'::jsonb,
    p_operation_id,p_target_judgment_id,p_requested_at,v_version,
    'teacher-correction:' || p_teacher_correction_id,p_operation_id
  );
  return query select p_operation_id,p_teacher_correction_id,v_version,'accepted'::text;
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_dimension_lineage','science_v3_retention_unit_revision',
    'science_v3_retention_unit_measurement_rule','science_v3_learning_opportunity',
    'science_v3_evidence_rejection','science_v3_delayed_review_event',
    'science_v3_mastery_projection','science_v3_retention_projection',
    'science_v3_teacher_correction'
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
    select o.event_id,o.tenant_id,o.operation_id,o.event_type,
           o.aggregate_type || ':' || o.aggregate_id,o.aggregate_version,
           o.payload_ref,o.occurred_at,o.delivery_attempts
      from public.infra_outbox o
     where o.published_at is null
       and o.event_type in (
         'question.cut_requested','selection.intent_revised','question.closed',
         'dream.rem_requested','dream.deep_requested','teacher.correction_recorded'
       )
     order by o.occurred_at,o.event_id
     limit p_limit;
end
$$;

revoke all on function mathpilot_science_v3_record_teacher_correction(
  text,text,text,text,text,text,text,text,text,jsonb,jsonb,text,text,text[],text,timestamptz
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant select on science_v3_evidence_policy to mathpilot_app;
    grant select on science_v3_mastery_parameter_set to mathpilot_app;
    grant select on science_v3_retention_parameter_set to mathpilot_app;
    grant select,insert on science_v3_dimension_lineage to mathpilot_app;
    grant select,insert on science_v3_retention_unit_revision to mathpilot_app;
    grant select,insert on science_v3_retention_unit_measurement_rule to mathpilot_app;
    grant select,insert on science_v3_learning_opportunity to mathpilot_app;
    grant select,insert on science_v3_evidence_rejection to mathpilot_app;
    grant select,insert on science_v3_delayed_review_event to mathpilot_app;
    grant select,insert,update on science_v3_mastery_projection to mathpilot_app;
    grant select,insert,update,delete on science_v3_retention_projection to mathpilot_app;
    grant select,insert on science_v3_teacher_correction to mathpilot_app;
    grant execute on function mathpilot_science_v3_record_teacher_correction(
      text,text,text,text,text,text,text,text,text,jsonb,jsonb,text,text,text[],text,timestamptz
    ) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0034_science_v3_scientific_core');
commit;
