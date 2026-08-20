begin;

-- 库外教学问答同样是持久 Pi Session，但不属于正式诊断证据。
create table runtime_teaching_conversation (
  conversation_id text primary key,
  tenant_id       text not null,
  student_id      text not null references identity_user(user_id),
  evidence_policy text not null default 'teaching_only' check (evidence_policy = 'teaching_only'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table runtime_teaching_conversation_turn (
  turn_id         text primary key,
  tenant_id       text not null,
  conversation_id text not null references runtime_teaching_conversation(conversation_id),
  turn            integer not null,
  role            text not null check (role in ('student','agent')),
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (conversation_id, turn)
);

-- Artifact 可以属于正式 QuestionSession，也可以属于 teaching-only conversation，
-- 但必须且只能有一个拥有者。
alter table runtime_learning_artifact alter column session_id drop not null;
alter table runtime_learning_artifact add column conversation_id text references runtime_teaching_conversation(conversation_id);
alter table runtime_learning_artifact add constraint runtime_learning_artifact_owner_ck
  check ((session_id is not null)::integer + (conversation_id is not null)::integer = 1);

alter table runtime_artifact_interaction alter column session_id drop not null;
alter table runtime_artifact_interaction add column conversation_id text references runtime_teaching_conversation(conversation_id);
alter table runtime_artifact_interaction add constraint runtime_artifact_interaction_owner_ck
  check ((session_id is not null)::integer + (conversation_id is not null)::integer = 1);

-- 每张已发布教学卡在自己的会话内只接受一次最终交互。
create unique index runtime_artifact_interaction_session_once_idx
  on runtime_artifact_interaction (tenant_id, session_id, artifact_id, card_id)
  where session_id is not null;
create unique index runtime_artifact_interaction_conversation_once_idx
  on runtime_artifact_interaction (tenant_id, conversation_id, artifact_id, card_id)
  where conversation_id is not null;

alter table runtime_teaching_conversation enable row level security;
create policy tenant_isolation on runtime_teaching_conversation
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));
alter table runtime_teaching_conversation_turn enable row level security;
create policy tenant_isolation on runtime_teaching_conversation_turn
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

create trigger forbid_mutation before update or delete on runtime_teaching_conversation_turn
  for each row execute function forbid_mutation();

insert into infra_schema_migration(version) values ('0013_artifact_interaction_once');
commit;
