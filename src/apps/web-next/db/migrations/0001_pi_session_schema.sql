-- Fresh schema for the independent KTQ/ER Pi Session metadata database.
-- Pi SessionManager JSONL/workspaces remain the transcript owner; this database
-- owns only tenant/user authorization and the durable local-path mapping.

begin;

do $$
declare
  schema_marker constant text := 'mathpilot.pi-session-schema/v2';
  previous_schema_marker constant text := 'mathpilot.pi-session-schema/v1';
begin
  if to_regclass('public.pi_threads') is not null
     and coalesce(obj_description(to_regclass('public.pi_threads'), 'pg_class'), '') not in (
       previous_schema_marker,
       schema_marker
     ) then
    raise exception 'unsupported legacy mathpilot_pi schema; keep/export it and provision a separate empty mathpilot_pi database';
  end if;
  if to_regclass('public.pi_threads') is null
     and to_regclass('public.pi_thread_acl') is not null then
    raise exception 'partial mathpilot_pi schema; keep/export it and provision a separate empty mathpilot_pi database';
  end if;
  if exists (
    select 1
      from pg_tables
     where schemaname = 'public'
       and tablename ~ '^pi_'
       and tablename not in ('pi_threads', 'pi_thread_acl')
  ) then
    raise exception 'unsupported legacy mathpilot_pi tables; keep/export them and provision a separate empty mathpilot_pi database';
  end if;
end
$$;

create table if not exists pi_threads (
  thread_id      text primary key,
  tenant_id      text not null,
  owner_user_id  text not null,
  session_dir    text not null unique,
  session_file   text not null unique,
  created_at     timestamptz not null default clock_timestamp(),
  constraint pi_threads_tenant_identity unique (thread_id, tenant_id),
  constraint pi_threads_session_dir_relative check (
    session_dir ~ '^sessions/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
  )
);

-- v1 stored files directly below agent/sessions. Pi's official SessionManager
-- discovers them in a cwd-scoped child directory instead. Keep accepting the
-- old form during online, compare-and-swap relocation; all new mappings use
-- the cwd-scoped form.
alter table pi_threads drop constraint if exists pi_threads_session_file_relative;
alter table pi_threads add constraint pi_threads_session_file_relative check (
  session_file ~ '^agent/sessions/(--[A-Za-z0-9._-]{1,251}--/)?[A-Za-z0-9][A-Za-z0-9._-]{0,248}\.jsonl$'
);

comment on table pi_threads is 'mathpilot.pi-session-schema/v2';

create index if not exists pi_threads_owner_idx
  on pi_threads (tenant_id, owner_user_id, created_at desc);

create table if not exists pi_thread_acl (
  thread_id   text not null,
  tenant_id   text not null,
  user_id     text not null,
  access      text not null check (access in ('read', 'write', 'admin')),
  created_at  timestamptz not null default clock_timestamp(),
  primary key (thread_id, user_id),
  foreign key (thread_id, tenant_id)
    references pi_threads(thread_id, tenant_id) on delete cascade
);

create index if not exists pi_thread_acl_user_idx
  on pi_thread_acl (tenant_id, user_id, thread_id);

alter table pi_threads enable row level security;
alter table pi_threads force row level security;
alter table pi_thread_acl enable row level security;
alter table pi_thread_acl force row level security;

drop policy if exists pi_threads_select on pi_threads;
drop policy if exists pi_threads_insert on pi_threads;
drop policy if exists pi_threads_update on pi_threads;
drop policy if exists pi_threads_delete on pi_threads;
drop policy if exists pi_thread_acl_select on pi_thread_acl;
drop policy if exists pi_thread_acl_insert on pi_thread_acl;
drop policy if exists pi_thread_acl_update on pi_thread_acl;
drop policy if exists pi_thread_acl_delete on pi_thread_acl;

create policy pi_thread_acl_select on pi_thread_acl for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and user_id = current_setting('mathpilot.user_id', true)
);

-- ACL mutation stays closed until an owner-authorized domain route owns it.
create policy pi_thread_acl_insert on pi_thread_acl for insert with check (false);
create policy pi_thread_acl_update on pi_thread_acl for update using (false) with check (false);
create policy pi_thread_acl_delete on pi_thread_acl for delete using (false);

create policy pi_threads_select on pi_threads for select using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or exists (
      select 1
        from pi_thread_acl acl
       where acl.thread_id = pi_threads.thread_id
         and acl.tenant_id = pi_threads.tenant_id
         and acl.user_id = current_setting('mathpilot.user_id', true)
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
      select 1
        from pi_thread_acl acl
       where acl.thread_id = pi_threads.thread_id
         and acl.tenant_id = pi_threads.tenant_id
         and acl.user_id = current_setting('mathpilot.user_id', true)
         and acl.access in ('write', 'admin')
    )
  )
) with check (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and (
    owner_user_id = current_setting('mathpilot.user_id', true)
    or exists (
      select 1
        from pi_thread_acl acl
       where acl.thread_id = pi_threads.thread_id
         and acl.tenant_id = pi_threads.tenant_id
         and acl.user_id = current_setting('mathpilot.user_id', true)
         and acl.access in ('write', 'admin')
    )
  )
);

create policy pi_threads_delete on pi_threads for delete using (
  tenant_id = current_setting('mathpilot.tenant_id', true)
  and owner_user_id = current_setting('mathpilot.user_id', true)
);

commit;
