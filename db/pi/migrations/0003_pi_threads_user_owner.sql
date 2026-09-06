-- Pi 线程只属于创建它的统一用户。
--
-- 0001/0002 曾把 student_id 当作访问范围的投影。访问范围现在由主库
-- 网关决定，Pi 库不再复制该身份领域字段。这个迁移先移除依赖旧字段的
-- RLS policy，再删除字段，因而可以安全地在已有开发库上重复执行。

begin;

drop policy if exists pi_card_events_select on pi_card_events;
drop policy if exists pi_card_events_insert on pi_card_events;
drop policy if exists pi_threads_select on pi_threads;
drop policy if exists pi_threads_insert on pi_threads;
drop policy if exists pi_threads_update on pi_threads;
drop policy if exists pi_threads_delete on pi_threads;

drop index if exists pi_threads_student_idx;
alter table pi_threads drop column if exists student_id;

create index if not exists pi_threads_owner_idx
  on pi_threads (tenant_id, owner_user_id, created_at desc);

-- ACL rows are not a tenant-wide capability list. A caller may inspect only
-- its own grant (needed by the thread predicates below), while ACL mutation is
-- disabled until a dedicated owner route can use a security-definer
-- transaction. Keeping the write policy closed is safer than letting an
-- ordinary tenant user grant itself access through a raw table query.
alter table pi_thread_acl enable row level security;
alter table pi_thread_acl force row level security;
drop policy if exists pi_thread_acl_tenant_scope on pi_thread_acl;
drop policy if exists pi_thread_acl_select on pi_thread_acl;
drop policy if exists pi_thread_acl_insert on pi_thread_acl;
drop policy if exists pi_thread_acl_update on pi_thread_acl;
drop policy if exists pi_thread_acl_delete on pi_thread_acl;

create policy pi_thread_acl_select on pi_thread_acl for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and user_id = current_setting('mathpilot.user_id', true)
);

create policy pi_thread_acl_insert on pi_thread_acl for insert with check (false);
create policy pi_thread_acl_update on pi_thread_acl for update using (false) with check (false);
create policy pi_thread_acl_delete on pi_thread_acl for delete using (false);

create policy pi_threads_select on pi_threads for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or exists (
      select 1 from pi_thread_acl a
      where a.thread_id = pi_threads.thread_id
        and a.tenant_id = pi_threads.tenant_id
        and a.user_id = current_setting('mathpilot.user_id', true)
    )
  )
);

create policy pi_threads_insert on pi_threads for insert with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and owner_user_id = current_setting('mathpilot.user_id', true)
);

create policy pi_threads_update on pi_threads for update using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or exists (
      select 1 from pi_thread_acl a
      where a.thread_id = pi_threads.thread_id
        and a.tenant_id = pi_threads.tenant_id
        and a.user_id = current_setting('mathpilot.user_id', true)
        and a.access in ('write', 'admin')
    )
  )
);

create policy pi_threads_delete on pi_threads for delete using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and owner_user_id = current_setting('mathpilot.user_id', true)
);

commit;
