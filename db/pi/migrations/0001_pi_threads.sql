-- 独立 mathpilot_pi 库的最小事实表；不依赖旧 MathPilot 迁移序列。
-- Pi 会话文件/工作区仍是对话事实源，本表只负责归属、定位和对象存储索引。

create table if not exists pi_threads (
  thread_id    text primary key,
  tenant_id    text not null,
  owner_user_id text not null,
  student_id   text not null,
  session_dir  text not null unique,
  session_file text not null unique,
  minio_key    text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  constraint pi_threads_session_dir_relative check (
    session_dir ~ '^sessions/[0-9a-f-]{36}$'
  ),
  constraint pi_threads_session_file_relative check (
    session_file ~ '^agent/sessions/.+\.jsonl$'
  )
);

create index if not exists pi_threads_owner_idx
  on pi_threads (tenant_id, owner_user_id, created_at desc);
create index if not exists pi_threads_student_idx
  on pi_threads (tenant_id, student_id, created_at desc);

-- 显式 ACL 可承载后续共享；师生范围由主业务库在网关实时校验，Pi 库不复制身份领域表。
create table if not exists pi_thread_acl (
  thread_id text not null references pi_threads(thread_id) on delete cascade,
  tenant_id text not null,
  user_id text not null,
  access text not null check (access in ('read', 'write', 'admin')),
  created_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create index if not exists pi_thread_acl_user_idx
  on pi_thread_acl (tenant_id, user_id, thread_id);

-- 应用层查询仍会显式判断归属；RLS 是新库的独立第二道边界。
-- API 网关验证出的主体通过事务局部 GUC 注入，不创建/复制身份领域表。
alter table pi_threads enable row level security;
alter table pi_threads force row level security;

drop policy if exists pi_threads_select on pi_threads;
create policy pi_threads_select on pi_threads for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
    or student_id = any(string_to_array(coalesce(current_setting('mathpilot.accessible_student_ids', true), ''), ','))
    or exists (
      select 1 from pi_thread_acl a
      where a.thread_id = pi_threads.thread_id
        and a.tenant_id = pi_threads.tenant_id
        and a.user_id = current_setting('mathpilot.user_id', true)
    )
  )
);

drop policy if exists pi_threads_insert on pi_threads;
create policy pi_threads_insert on pi_threads for insert with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and owner_user_id = current_setting('mathpilot.user_id', true)
  and (
    student_id = current_setting('mathpilot.user_id', true)
    or student_id = any(string_to_array(coalesce(current_setting('mathpilot.accessible_student_ids', true), ''), ','))
  )
);

drop policy if exists pi_threads_update on pi_threads;
create policy pi_threads_update on pi_threads for update using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
    or student_id = any(string_to_array(coalesce(current_setting('mathpilot.accessible_student_ids', true), ''), ','))
    or exists (
      select 1 from pi_thread_acl a
      where a.thread_id = pi_threads.thread_id
        and a.tenant_id = pi_threads.tenant_id
        and a.user_id = current_setting('mathpilot.user_id', true)
        and a.access in ('write', 'admin')
    )
  )
);

drop policy if exists pi_threads_delete on pi_threads;
create policy pi_threads_delete on pi_threads for delete using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
    or student_id = any(string_to_array(coalesce(current_setting('mathpilot.accessible_student_ids', true), ''), ','))
    or exists (
      select 1 from pi_thread_acl a
      where a.thread_id = pi_threads.thread_id
        and a.tenant_id = pi_threads.tenant_id
        and a.user_id = current_setting('mathpilot.user_id', true)
        and a.access in ('write', 'admin')
    )
  )
);

alter table pi_thread_acl enable row level security;
alter table pi_thread_acl force row level security;
drop policy if exists pi_thread_acl_tenant_scope on pi_thread_acl;
create policy pi_thread_acl_tenant_scope on pi_thread_acl for all
  using (tenant_id = current_setting('mathpilot.tenant_id', true))
  with check (tenant_id = current_setting('mathpilot.tenant_id', true));
