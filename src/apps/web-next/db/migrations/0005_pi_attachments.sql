-- 线程附件的最小登记表。稳定内容必须先进入 MinIO；Pi workspace 只保存
-- 当前模型回合的物化副本，不是浏览器下载事实源。

begin;

create table if not exists pi_attachments (
  attachment_id      uuid primary key,
  thread_id          text not null references pi_threads(thread_id) on delete cascade,
  tenant_id          text not null,
  uploaded_by_user_id text not null,
  storage_object_id  text not null,
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

do $$
begin
  if exists (select 1 from pi_attachments where storage_object_id is null) then
    raise exception 'pi_attachments contains local-only compatibility rows; migrate or remove them before enabling MinIO-only attachments';
  end if;
  alter table pi_attachments alter column storage_object_id set not null;
end
$$;

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
  and uploaded_by_user_id = current_setting('mathpilot.user_id', true)
) with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and uploaded_by_user_id = current_setting('mathpilot.user_id', true)
  and exists (
    select 1 from pi_threads t
    where t.thread_id = pi_attachments.thread_id
      and t.tenant_id = pi_attachments.tenant_id
      and (
        t.owner_user_id = current_setting('mathpilot.user_id', true)
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
  and uploaded_by_user_id = current_setting('mathpilot.user_id', true)
);

commit;
