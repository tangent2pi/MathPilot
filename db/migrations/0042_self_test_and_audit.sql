-- 0042: science-v3 self-test (熟练度自我测评) + answer audit queue.
--
-- Adds a self-contained assessment domain for the MathPilot "自我测评"
-- (composer 回形针旁按钮 → Dialog 选 章节/知识点/难度 → 逐题作答):
--   * science_v3_self_test_run       -- 一轮测评的进度载体 (刷新后续测, 单例锁)
--   * science_v3_self_test_answer    -- 每题作答事实 (immutable, BKT 重放输入)
--   * science_v3_self_test_audit     -- 疑似错答案审计队列 (题ID/原答案/AI或学生响应/上下文)
--   * mathpilot_science_v3_append_self_test_report() -- 把文字报告追加为一条
--                                        author_kind='assistant' 的 canonical message,
--                                        使其自然出现在对话消息流 (SSE 推送, 前端零改动)
--
-- 判定口径 (与 bkt-oatutor-prior-v1 / scientific-core 同构):
--   先验 p0=0.30, 失误 s=0.10, 猜测 g=0.20, 学习转移 tau=0.0
--   状态阈值 { minimum_independent_count:2, weak:0.4, learning:0.8, mastered:0.95 }
--   mastered 需要 p>=0.95 且存在迁移证据 (换题型后答对)
begin;

create table if not exists science_v3_self_test_run (
  run_id                text primary key check (run_id ~ '^str_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  user_id               text not null references identity_user(user_id),
  conversation_thread_id text not null,
  status                text not null default 'active' check (status in ('active','finished','cancelled')),
  -- 测评配置: { chapter_id, knowledge_ids:[K_..], difficulty(起始 0..1), quick?,
  --            question_cap, per_knowledge_cap, switch_accuracy, switch_min_answers,
  --            window_size, window_up, window_down_rate }
  config                jsonb not null check (config ?& array['knowledge_ids','difficulty']),
  -- 运行时自适应状态: { dimension_order:[K_..], window:[0/1..], per_dim:{K_:{answered,correct,transfer}},
  --                     used_revisions:[qrev_..], next_dim_index, difficulty_now, last_format }
  state                 jsonb not null default '{}'::jsonb,
  version               bigint not null default 1 check (version > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  unique (tenant_id, run_id),
  foreign key (tenant_id, conversation_thread_id)
    references science_v3_conversation_thread(tenant_id, conversation_thread_id)
);

-- 同一学生同一租户同时只允许一个进行中的测评轮 (决策: 不允许并行测评)
create unique index science_v3_self_test_run_active_uidx
  on science_v3_self_test_run (tenant_id, user_id)
  where status = 'active';

create table if not exists science_v3_self_test_answer (
  answer_id             text primary key check (answer_id ~ '^sta_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  run_id                text not null,
  user_id               text not null references identity_user(user_id),
  sequence              bigint not null check (sequence > 0),
  question_revision_id  text not null check (question_revision_id ~ '^qrev_[A-Za-z0-9_.:-]{4,}$'),
  -- 作答归属维度 (知识点 K_ / 题型 T_), 与 science_v3_mastery_projection 同一前缀口径
  dimension_id          text not null check (dimension_id ~ '^(K|T)_[A-Z0-9_]{2,}$'),
  stem_format           text not null check (stem_format in ('single_choice','fill_blank')),
  response_text         text not null check (length(response_text) <= 2000),
  verdict               text not null check (verdict in ('correct','incorrect')),
  -- 自动判答的机器可读依据 (期望答案/匹配方式), 供审计追溯
  auto_grade            jsonb not null,
  difficulty_served     double precision not null check (difficulty_served between 0 and 1),
  independent           boolean not null default true,
  idempotency_key       text not null,
  submitted_at          timestamptz not null,
  fact_version          bigint not null default 1 check (fact_version > 0),
  unique (tenant_id, answer_id),
  unique (tenant_id, run_id, sequence),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, run_id) references science_v3_self_test_run(tenant_id, run_id)
);

create table if not exists science_v3_self_test_audit (
  audit_id              text primary key check (audit_id ~ '^sau_[A-Za-z0-9]{8,}$'),
  tenant_id             text not null references identity_tenant(tenant_id),
  question_entity_id    text not null,
  question_revision_id  text not null,
  answer_text           text not null,           -- 题库登记的原答案
  student_response      text not null,           -- 学生响应 (可能是正确答案却被题库答案判错)
  context               jsonb not null default '{}'::jsonb, -- {run_id,sequence,stem_format,stem,auto_grade,flag}
  status                text not null default 'pending' check (status in ('pending','resolved','rejected')),
  created_by_user_id    text not null references identity_user(user_id),
  created_at            timestamptz not null default now(),
  resolved_by_user_id   text references identity_user(user_id),
  resolved_at           timestamptz,
  resolution            text
);

-- 运行态保护: run 只能沿 active -> finished|cancelled 前进
create or replace function science_v3_self_test_run_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'self-test run cannot be deleted'; end if;
  if new.run_id is distinct from old.run_id
     or new.tenant_id is distinct from old.tenant_id
     or new.user_id is distinct from old.user_id
     or new.conversation_thread_id is distinct from old.conversation_thread_id
     or new.config is distinct from old.config then
    raise exception 'self-test run identity and config are immutable';
  end if;
  if old.status = 'finished' or old.status = 'cancelled' then
    if new.status <> old.status or new.finished_at is distinct from old.finished_at then
      raise exception 'terminal self-test run cannot change status';
    end if;
  elsif new.status not in ('active','finished','cancelled') or new.version <> old.version + 1 then
    raise exception 'invalid self-test run transition';
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_self_test_run_guard before update or delete on science_v3_self_test_run
  for each row execute function science_v3_self_test_run_guard();

create or replace function science_v3_self_test_audit_guard() returns trigger as $$
begin
  if TG_OP = 'DELETE' then raise exception 'self-test audit cannot be deleted'; end if;
  if old.status <> 'pending' then
    raise exception 'only pending audits are mutable; resolved audits are append-only';
  end if;
  if new.status not in ('pending','resolved','rejected') then
    raise exception 'invalid audit status transition';
  end if;
  return new;
end
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_self_test_run','science_v3_self_test_answer','science_v3_self_test_audit'
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

-- 答案事实不可变 (run 的 guard 已在上面定义, 只挂一次)
create trigger science_v3_self_test_answer_immutable before update or delete on science_v3_self_test_answer
  for each row execute function forbid_mutation();
create trigger science_v3_self_test_audit_guard before update on science_v3_self_test_audit
  for each row execute function science_v3_self_test_audit_guard();
create trigger science_v3_self_test_audit_delete before delete on science_v3_self_test_audit
  for each row execute function forbid_mutation();

-- 追加一条 assistant 报告消息到对话线程 (照抄 0038 commit_foreground_response 的写入模板):
-- 读 thread (for update) -> insert canonical_message(author_kind='assistant', lifecycle='committed') -> bump sequence/version
create or replace function mathpilot_science_v3_append_self_test_report(
  p_tenant_id text,
  p_thread_id text,
  p_user_id text,
  p_message_id text,
  p_parts jsonb,
  p_requested_at timestamptz
) returns table (canonical_message_id text, thread_version bigint)
language plpgsql
as $$
declare
  v_thread science_v3_conversation_thread%rowtype;
  v_student science_v3_student%rowtype;
  v_version bigint;
begin
  if p_message_id !~ '^msg_[A-Za-z0-9]{8,}$' then raise exception 'invalid message id'; end if;
  if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) < 1
     or pg_column_size(p_parts) > 1048576 then
    raise exception 'invalid report parts';
  end if;
  select * into v_thread from science_v3_conversation_thread
   where tenant_id = p_tenant_id and conversation_thread_id = p_thread_id
   for update;
  if not found or v_thread.status <> 'active' then
    raise exception 'active conversation thread not found';
  end if;
  select * into v_student from science_v3_student
   where tenant_id = p_tenant_id and student_id = v_thread.student_id;
  if not found or v_student.user_id <> p_user_id then
    raise exception 'conversation thread does not belong to requested user';
  end if;
  insert into science_v3_canonical_message (
    message_id, tenant_id, conversation_thread_id, sequence, author_kind, author_user_id,
    foreground_epoch_id, lifecycle, parts, question_session_id, editable, lock_reason,
    created_at, version
  ) values (
    p_message_id, p_tenant_id, p_thread_id, v_thread.next_message_sequence,
    'assistant', null, null, 'committed', p_parts, null, false, 'domain_event',
    p_requested_at, 1
  );
  v_version := v_thread.version + 1;
  update science_v3_conversation_thread
     set next_message_sequence = next_message_sequence + 1,
         updated_at = clock_timestamp(), version = v_version
   where tenant_id = p_tenant_id and conversation_thread_id = p_thread_id;
  return query select p_message_id, v_version;
end
$$;

revoke all on function mathpilot_science_v3_append_self_test_report(text,text,text,text,jsonb,timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mathpilot_app') then
    grant select,insert,update on science_v3_self_test_run to mathpilot_app;
    grant select,insert on science_v3_self_test_answer to mathpilot_app;
    grant select,insert,update on science_v3_self_test_audit to mathpilot_app;
    grant execute on function mathpilot_science_v3_append_self_test_report(text,text,text,text,jsonb,timestamptz) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0042_self_test_and_audit');
commit;
