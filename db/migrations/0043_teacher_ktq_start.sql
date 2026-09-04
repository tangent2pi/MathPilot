-- 0043: 教师私有资料“开始解析”→ KTQ 抽取的一次性派发命令。
-- 目标线程是教师对话线程（材料已通过附件绑定到 input/original/）；派发后由
-- content-to-pi 轮询器调用 pi-chat-runtime /internal/ktq-start，模型按
-- ktq-extraction Skill 完成后调 respond 注册 candidate_set（走既有审核/发布链）。
begin;

create table if not exists content_ktq_start_command (
  command_id         text primary key,
  tenant_id          text not null references identity_tenant(tenant_id),
  owner_teacher_user_id text not null references identity_user(user_id),
  target_thread_id   text not null,
  chapter_id         text,
  status             text not null default 'pending' check (status in ('pending', 'dispatched')),
  attempt_count      integer not null default 0 check (attempt_count >= 0),
  last_error         text,
  next_attempt_at    timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  dispatched_at      timestamptz,
  unique (target_thread_id)
);
create index if not exists content_ktq_start_command_pending_idx
  on content_ktq_start_command (status, next_attempt_at, created_at);

alter table content_ktq_start_command enable row level security;
alter table content_ktq_start_command force row level security;
drop policy if exists tenant_isolation on content_ktq_start_command;
create policy tenant_isolation on content_ktq_start_command
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

create or replace function mathpilot_pending_ktq_start_commands()
returns table(
  command_id text,
  tenant_id text,
  owner_user_id text,
  target_thread_id text,
  chapter_id text,
  attempt_count integer
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select c.command_id,c.tenant_id,c.owner_teacher_user_id,c.target_thread_id,c.chapter_id,c.attempt_count
    from public.content_ktq_start_command c
   where c.status='pending' and c.next_attempt_at <= now() order by c.created_at
$$;
revoke all on function mathpilot_pending_ktq_start_commands() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant execute on function mathpilot_pending_ktq_start_commands() to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0043_teacher_ktq_start') on conflict (version) do nothing;
commit;
