-- 题卡交互的不可变审计通道。Pi JSONL 继续保存对话中的回答文本；
-- 本表只保存经服务端核对过的结构化事件，不承担判答或掌握度更新。

create table if not exists pi_card_events (
  event_id       uuid primary key,
  thread_id      text not null references pi_threads(thread_id) on delete cascade,
  tenant_id      text not null,
  student_id     text not null,
  tool_call_id   text not null,
  artifact_id    text not null check (artifact_id ~ '^art_[A-Za-z0-9]{8,92}$'),
  card_id        text not null check (card_id ~ '^card_[A-Za-z0-9]+$'),
  response_type  text not null check (response_type in ('submitted', 'skipped', 'bypassed_free_text')),
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  unique (thread_id, tool_call_id)
);

create index if not exists pi_card_events_student_idx
  on pi_card_events (tenant_id, student_id, created_at desc);

alter table pi_card_events enable row level security;
alter table pi_card_events force row level security;

create policy pi_card_events_select on pi_card_events for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_card_events.thread_id
  )
);

create policy pi_card_events_insert on pi_card_events for insert with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_card_events.thread_id
      and t.student_id = pi_card_events.student_id
  )
);
