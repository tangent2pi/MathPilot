-- 线程附件的最小登记表。
-- 文件内容可以暂时位于 Pi workspace；迁移到 MinIO 后只需填充
-- storage_object_id，不需要改变对话线程或旧 JSONL。

begin;

create table if not exists pi_attachments (
  attachment_id      uuid primary key,
  thread_id          text not null references pi_threads(thread_id) on delete cascade,
  tenant_id          text not null,
  uploaded_by_user_id text not null,
  storage_object_id  text,
  workspace_path     text not null,
  original_name      text not null,
  mime_type          text not null,
  byte_size          bigint not null check (byte_size >= 0),
  sha256             text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  constraint pi_attachments_workspace_path_check check (
    workspace_path ~ '^input/original/[^/]+$'
  ),
  unique (thread_id, workspace_path),
  unique (thread_id, storage_object_id)
);

create index if not exists pi_attachments_thread_idx
  on pi_attachments (tenant_id, thread_id, created_at desc);

alter table pi_attachments enable row level security;
alter table pi_attachments force row level security;

drop policy if exists pi_attachments_select on pi_attachments;
create policy pi_attachments_select on pi_attachments for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_attachments.thread_id
      and t.tenant_id = pi_attachments.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
        or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
        or exists (
          select 1 from pi_thread_acl a
          where a.thread_id = t.thread_id
            and a.tenant_id = t.tenant_id
            and a.user_id = current_setting('mathpilot.user_id', true)
        )
      )
  )
);

drop policy if exists pi_attachments_insert on pi_attachments;
create policy pi_attachments_insert on pi_attachments for insert with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and uploaded_by_user_id = current_setting('mathpilot.user_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_attachments.thread_id
      and t.tenant_id = pi_attachments.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
        or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
        or exists (
          select 1 from pi_thread_acl a
          where a.thread_id = t.thread_id
            and a.tenant_id = t.tenant_id
            and a.user_id = current_setting('mathpilot.user_id', true)
            and a.access in ('write', 'admin')
        )
      )
  )
);

drop policy if exists pi_attachments_update on pi_attachments;
create policy pi_attachments_update on pi_attachments for update using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    uploaded_by_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
  )
) with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    uploaded_by_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
  )
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_attachments.thread_id
      and t.tenant_id = pi_attachments.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
        or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
        or exists (
          select 1 from pi_thread_acl a
          where a.thread_id = t.thread_id
            and a.tenant_id = t.tenant_id
            and a.user_id = current_setting('mathpilot.user_id', true)
            and a.access in ('write', 'admin')
        )
      )
  )
);

drop policy if exists pi_attachments_delete on pi_attachments;
create policy pi_attachments_delete on pi_attachments for delete using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    uploaded_by_user_id = current_setting('mathpilot.user_id', true)
    or 'tenant_admin' = any(string_to_array(coalesce(current_setting('mathpilot.roles', true), ''), ','))
  )
);

commit;
