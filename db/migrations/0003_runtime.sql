-- 0003: runtime 族（设计 §14.2）— Session、作答、观测、Artifact、双产物
begin;

create table runtime_assessment_run (
  run_id       text primary key,
  tenant_id    text not null,
  student_id   text not null references identity_user(user_id),
  goal         text not null,
  budget       jsonb not null,
  status       text not null default 'active',
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index runtime_run_student_idx on runtime_assessment_run(tenant_id, student_id);

create table runtime_question_session (
  session_id              text primary key,
  tenant_id               text not null,
  student_id              text not null references identity_user(user_id),
  run_id                  text references runtime_assessment_run(run_id),
  question_id             text not null,
  chapter_package_version text not null,
  mode                    text not null check (mode in ('diagnostic','help','review')),
  draft_enabled           boolean not null,
  state                   text not null,
  state_history           jsonb not null default '[]',
  hint_level              integer not null default 0,
  probe_rounds            integer not null default 0,
  termination_reason      text,
  payload                 jsonb not null,
  started_at              timestamptz not null default now(),
  closed_at               timestamptz
);
create index runtime_session_student_idx on runtime_question_session(tenant_id, student_id, started_at desc);

create table runtime_attempt (
  attempt_id   text primary key,
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  student_id   text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index runtime_attempt_session_idx on runtime_attempt(session_id);

create table runtime_chat_turn (
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  turn         integer not null,
  role         text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (session_id, turn)
);

-- 笔迹原始流在对象存储；本表仅为索引（设计 §14.1）
create table runtime_stroke_event_index (
  tenant_id     text not null,
  session_id    text not null references runtime_question_session(session_id),
  stream_ref    text not null,
  content_hash  text not null,
  event_count   integer not null,
  created_at    timestamptz not null default now(),
  primary key (session_id, stream_ref)
);

create table runtime_draft_segment (
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  segment_id   text not null,
  time_range   tstzrange,
  bbox         double precision[],
  thumbnail_ref text,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (session_id, segment_id)
);

create table runtime_answer_verdict (
  judgment_id  text primary key,
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  attempt_id   text not null references runtime_attempt(attempt_id),
  verdict      text not null check (verdict in ('correct','partially_correct','incorrect','unresolved')),
  uncertainty  text not null,
  model_id     text not null,
  prompt_version text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);
create index runtime_verdict_session_idx on runtime_answer_verdict(session_id);

create table runtime_diagnostic_claim (
  claim_id     text primary key,
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  status       text not null default 'open',
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

-- 观测：教师纠正只允许 supersede（trigger 见 0006）
create table runtime_state_observation (
  observation_id text primary key,
  tenant_id      text not null,
  student_id     text not null,
  dimension_id   text not null,
  question_id    text not null,
  session_id     text not null references runtime_question_session(session_id),
  judgment_id    text references runtime_answer_verdict(judgment_id),
  outcome        text not null check (outcome in ('success','failure','unresolved')),
  independent    boolean not null,
  evidence_rule  text not null,
  hint_level     integer not null check (hint_level between 0 and 5),
  supersedes     text,
  superseded_by  text,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  check (not independent or hint_level = 0) -- 独立证据必须零提示（提示后成功 independent=false）
);
create index runtime_observation_dim_idx on runtime_state_observation(tenant_id, student_id, dimension_id, created_at);

create table runtime_intervention_event (
  event_id     text primary key,
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  kind         text not null,
  hint_level   integer,
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

create table runtime_learning_artifact (
  artifact_id  text primary key,
  tenant_id    text not null,
  session_id   text not null references runtime_question_session(session_id),
  kind         text not null,
  renderer     text not null,
  artifact_uri text not null unique,
  created_at   timestamptz not null default now()
);

create table runtime_artifact_version (
  artifact_version_id text primary key,
  tenant_id           text not null,
  artifact_id         text not null references runtime_learning_artifact(artifact_id),
  manifest            jsonb not null,
  files_hash          text not null,
  storage_prefix      text not null,
  created_at          timestamptz not null default now()
);

-- 卡片交互：submitted / skipped / bypassed_free_text（跳过往后不生成失败观测由应用层保证）
create table runtime_artifact_interaction (
  response_id    text primary key,
  tenant_id      text not null,
  session_id     text not null references runtime_question_session(session_id),
  artifact_id    text not null references runtime_learning_artifact(artifact_id),
  card_id        text not null,
  student_id     text not null,
  response_type  text not null check (response_type in ('submitted','skipped','bypassed_free_text')),
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index runtime_interaction_session_idx on runtime_artifact_interaction(session_id);

create table runtime_teaching_session_summary (
  summary_id    text primary key,
  tenant_id     text not null,
  session_id    text not null references runtime_question_session(session_id),
  ser_id        text not null,   -- 跨族软引用 state_scientific_evaluation_report
  model_id      text not null,
  prompt_version text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now()
);

create table runtime_session_learning_record (
  record_id     text primary key,
  tenant_id     text not null,
  session_id    text not null references runtime_question_session(session_id),
  student_id    text not null,
  ser_id        text not null,
  tss_id        text not null references runtime_teaching_session_summary(summary_id),
  integrity_passed boolean not null,
  handoff_ref   text,
  dream_queued_at timestamptz,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  unique (session_id),
  unique (ser_id),
  unique (tss_id)
);

insert into infra_schema_migration(version) values ('0003_runtime');
commit;
