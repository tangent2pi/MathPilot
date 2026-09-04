-- 0044: 教师私有资料链路的候选集自动批准。
-- ktq-start/er-start 命令派发成功后，对应线程产生的候选集无需教师逐条点击审核；
-- 由轮询器自动 approve（复用 decide 语义），分别触发 ER 与最终教师包生成。
begin;

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
       -- 来自 ktq-start 派发线程的 KTQ 候选
       exists (
         select 1 from public.content_ktq_start_command k
          where k.tenant_id=s.tenant_id and k.target_thread_id=s.thread_id
            and k.status='dispatched'
       )
       or (
         s.phase='er'
         and exists (
           select 1 from public.content_er_start_command e
            join public.content_candidate_set parent
              on parent.candidate_set_id=e.approved_ktq_candidate_set_id
            join public.content_ktq_start_command k
              on k.tenant_id=e.tenant_id and k.target_thread_id=parent.thread_id
             and k.status='dispatched'
            where e.tenant_id=s.tenant_id and e.target_thread_id=s.thread_id
              and e.status='dispatched'
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

insert into infra_schema_migration(version) values ('0044_teacher_auto_private') on conflict (version) do nothing;
commit;
