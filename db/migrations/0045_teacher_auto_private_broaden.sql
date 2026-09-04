-- 0045: 放宽教师私有自动批准范围。
-- 教师在自己的对话线程（thr_…）中直接生成并 respond 的 KTQ 候选，同样属于
-- “上传资料自动入库”链路，无需先创建过 ktq_start_command，避免停在待复核。
begin;

drop function if exists mathpilot_pending_auto_private_candidates();
create or replace function mathpilot_pending_auto_private_candidates()
returns table(
  candidate_set_id text,
  tenant_id text,
  owner_user_id text,
  phase text
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.candidate_set_id,s.tenant_id,s.owner_teacher_user_id,s.phase
    from public.content_candidate_set s
   where s.status='pending_review'
     and (
       -- KTQ：来自 ktq-start 派发线程，或来自教师自有对话线程（thr_ 前缀）
       (
         s.phase='ktq'
         and (
           left(s.thread_id, 4) = 'thr_'
           or exists (
             select 1 from public.content_ktq_start_command k
              where k.tenant_id=s.tenant_id and k.target_thread_id=s.thread_id
                and k.status='dispatched'
           )
         )
       )
       or (
         s.phase='er'
         and exists (
           select 1 from public.content_er_start_command e
            join public.content_candidate_set parent
              on parent.candidate_set_id=e.approved_ktq_candidate_set_id
            where e.tenant_id=s.tenant_id and e.target_thread_id=s.thread_id
              and e.status='dispatched'
              and (
                left(parent.thread_id, 4) = 'thr_'
                or exists (
                  select 1 from public.content_ktq_start_command k
                   where k.tenant_id=e.tenant_id and k.target_thread_id=parent.thread_id
                     and k.status='dispatched'
                )
              )
         )
       )
     )
   order by s.created_at
$$;
revoke all on function mathpilot_pending_auto_private_candidates() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant execute on function mathpilot_pending_auto_private_candidates() to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0045_teacher_auto_private_broaden') on conflict (version) do nothing;
commit;
