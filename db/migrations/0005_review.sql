-- 0005: review 族（设计 §14.2）— 复核、纠正、发布、评测、追踪
begin;

create table review_review_task (
  task_id      text primary key,
  tenant_id    text not null,
  queue        text not null check (queue in ('content','student_diagnosis')),
  target_type  text not null,
  target_id    text not null,
  status       text not null default 'pending' check (status in ('pending','confirmed','modified','rejected','merged')),
  assignee_id  text references identity_user(user_id),
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index review_task_queue_idx on review_review_task(tenant_id, queue, status);

-- 教师纠正：supersede + 重放，禁止加权追加（ADR-004）
create table review_teacher_correction (
  correction_id  text primary key,
  tenant_id      text not null,
  target_type    text not null,
  target_id      text not null,
  action         text not null check (action in ('supersede','retract','edit_field')),
  replacement_ref text,
  reason         text not null,
  reviewer_id    text not null references identity_user(user_id),
  replay_status  text not null default 'pending' check (replay_status in ('pending','replaying','replayed','failed')),
  replay_result_ref text,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index review_correction_tenant_idx on review_teacher_correction(tenant_id, created_at);

create table review_release_record (
  release_id   text primary key,
  tenant_id    text not null,
  package_id   text not null,
  action       text not null check (action in ('publish','withdraw')),
  actor_id     text not null references identity_user(user_id),
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

create table review_evaluation_run (
  evaluation_id text primary key,
  tenant_id     text not null,
  eval_kind     text not null,   -- judging / profile / ocr / extraction / injection
  golden_set    text not null,
  metrics       jsonb not null,
  created_at    timestamptz not null default now()
);

-- 全链路追踪：模型/工具调用、Provider trace、状态变化（不含隐藏思维链，设计 §16.5）
create table review_agent_trace (
  trace_id       text primary key,
  tenant_id      text not null,
  correlation_id text,
  causation_id   text,
  session_id     text,
  provider_kind  text,
  implementation text,
  operation      text,
  status         text not null,
  latency_ms     integer,
  usage          jsonb,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index review_trace_session_idx on review_agent_trace(tenant_id, session_id);
create index review_trace_correlation_idx on review_agent_trace(correlation_id);

insert into infra_schema_migration(version) values ('0005_review');
commit;
