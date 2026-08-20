-- 同一学生、同一学习目标只保留一个可继续的 AssessmentRun。
-- 历史重复轮次不删除：有作答/对话的轮次优先，其余标记为 superseded，
-- 既保留审计证据，也避免刷新或重复点击不断从第一题重新开始。
with ranked as (
  select r.run_id,
         row_number() over (
           partition by r.tenant_id, r.student_id, r.goal
           order by
             case
               when q.state not in ('CREATE', 'CLOSED') then 5
               when exists (select 1 from runtime_attempt a where a.session_id = q.session_id) then 4
               when exists (select 1 from runtime_chat_turn t where t.session_id = q.session_id) then 3
               when q.state = 'CLOSED' then 2
               else 0
             end desc,
             r.created_at desc
         ) as position
    from runtime_assessment_run r
    left join runtime_question_session q
      on q.session_id = r.payload->>'current_session'
   where r.status = 'active'
)
update runtime_assessment_run r
   set status = 'superseded',
       payload = r.payload || jsonb_build_object(
         'superseded_at', now(),
         'superseded_reason', 'duplicate_active_run')
  from ranked x
 where r.run_id = x.run_id
   and x.position > 1;

create unique index if not exists runtime_one_active_run_per_goal
  on runtime_assessment_run (tenant_id, student_id, goal)
  where status = 'active';
