-- 0004: state 族（设计 §14.2）— 程序评价、Dream 决策、画像状态与快照
begin;

create table state_scientific_evaluation_report (
  report_id       text primary key,
  tenant_id       text not null,
  session_id      text not null,
  student_id      text not null,
  dimension_id    text not null,
  p_bkt_baseline  double precision not null check (p_bkt_baseline between 0 and 1),
  calibration_status text not null check (calibration_status in ('prior_only','calibrated')),
  parameter_set_id text not null,
  kernel_version  text,
  payload         jsonb not null,
  created_at      timestamptz not null default now()
);
create index state_ser_student_idx on state_scientific_evaluation_report(tenant_id, student_id, created_at);

create table state_profile_evidence_bundle (
  bundle_id        text primary key,
  tenant_id        text not null,
  student_id       text not null,
  prior_snapshot_id text,
  trigger          text not null,
  payload          jsonb not null,
  created_at       timestamptz not null default now()
);
create index state_peb_student_idx on state_profile_evidence_bundle(tenant_id, student_id, created_at);

-- 画像大模型最终决策：长期画像唯一模型写入口（ADR-004）
create table state_profile_update_decision (
  decision_id      text primary key,
  tenant_id        text not null,
  student_id       text not null,
  evidence_bundle_id text references state_profile_evidence_bundle(bundle_id),
  prior_snapshot_id text,
  supersedes       text,
  review_required  boolean not null default false,
  model_id         text not null,
  prompt_version   text not null,
  skill_version    text not null,
  payload          jsonb not null,
  created_at       timestamptz not null default now()
);
create index state_pud_student_idx on state_profile_update_decision(tenant_id, student_id, created_at);

create table state_profile_decision_validation (
  validation_id    text primary key,
  tenant_id        text not null,
  decision_id      text not null references state_profile_update_decision(decision_id),
  result           text not null check (result in ('passed','returned_to_model','escalated_to_teacher')),
  validator_version text not null,
  payload          jsonb not null,
  validated_at     timestamptz not null default now()
);
create index state_pdv_decision_idx on state_profile_decision_validation(decision_id);

-- 掌握状态（由通过校验的 PUD 物化；程序评价器无写权限，由部署账号约束）
create table state_mastery_state (
  tenant_id      text not null,
  student_id     text not null,
  dimension_id   text not null,
  p_profile      double precision not null check (p_profile between 0 and 1),
  state          text not null check (state in ('insufficient_evidence','weak','learning','possibly_mastered','mastered')),
  source_decision_id text not null references state_profile_update_decision(decision_id),
  updated_at     timestamptz not null default now(),
  primary key (student_id, dimension_id)
);

create table state_retention_state (
  tenant_id      text not null,
  student_id     text not null,
  dimension_id   text not null,
  i90_posterior  jsonb not null,   -- 稳定度网格后验分布
  next_review_due timestamptz,
  stable         boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (student_id, dimension_id)
);

create table state_misconception_state (
  tenant_id      text not null,
  student_id     text not null,
  error_cause_id text not null,
  state          text not null check (state in ('suspected','confirmed','improving','resolved','superseded')),
  evidence_refs  jsonb not null,
  updated_at     timestamptz not null default now(),
  primary key (student_id, error_cause_id)
);

create table state_student_snapshot (
  snapshot_id       text primary key,
  tenant_id         text not null,
  student_id        text not null,
  source_decision_id text not null references state_profile_update_decision(decision_id),
  supersedes        text,
  profile_lag       boolean not null default false,
  payload           jsonb not null,
  published_at      timestamptz not null default now()
);
create index state_snapshot_student_idx on state_student_snapshot(tenant_id, student_id, published_at desc);

create table state_review_schedule (
  tenant_id      text not null,
  student_id     text not null,
  dimension_id   text not null,
  due_at         timestamptz not null,
  reason         text not null,
  created_at     timestamptz not null default now(),
  primary key (student_id, dimension_id, due_at)
);

create table state_learning_plan (
  plan_id        text primary key,
  tenant_id      text not null,
  student_id     text not null,
  horizon_weeks  integer not null check (horizon_weeks between 1 and 4),
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);

insert into infra_schema_migration(version) values ('0004_state');
commit;
