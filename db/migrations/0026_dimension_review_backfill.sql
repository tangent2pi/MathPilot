-- 0026: 知识点与题型也是教师发布前需要复核的结构化内容。
-- 为既有内容补建一次待复核任务；新管线由 content-service 在写入前登记。
begin;

with visible_scope as (
  select distinct on (tenant_id, entity_type, entity_id)
         tenant_id, entity_type, entity_id, visibility, owner_teacher_id, source_pipeline_id
    from content_entity_scope
   where entity_type in ('knowledge_component', 'question_type')
   order by tenant_id, entity_type, entity_id, created_at desc
), candidates as (
  select k.tenant_id,
         'knowledge_component'::text as target_type,
         k.dimension_id as target_id,
         k.payload || jsonb_build_object(
           'id', k.dimension_id,
           'name', k.name,
           'related_questions', coalesce((
             select jsonb_agg(distinct mt.question_id order by mt.question_id)
               from content_measurement_target mt where mt.dim = k.dimension_id
           ), '[]'::jsonb)
         ) as candidate,
         s.visibility, s.owner_teacher_id, s.source_pipeline_id,
         (select q.chapter_id from content_measurement_target mt
           join content_question q on q.question_id=mt.question_id
          where mt.dim=k.dimension_id order by q.created_at limit 1) as chapter_id
    from content_knowledge_component k
    join visible_scope s on s.tenant_id=k.tenant_id
      and s.entity_type='knowledge_component' and s.entity_id=k.dimension_id
  union all
  select t.tenant_id,
         'question_type'::text,
         t.dimension_id,
         t.payload || jsonb_build_object(
           'id', t.dimension_id,
           'name', t.name,
           'related_questions', coalesce((
             select jsonb_agg(distinct mt.question_id order by mt.question_id)
               from content_measurement_target mt where mt.dim = t.dimension_id
           ), '[]'::jsonb)
         ),
         s.visibility, s.owner_teacher_id, s.source_pipeline_id,
         (select q.chapter_id from content_measurement_target mt
           join content_question q on q.question_id=mt.question_id
          where mt.dim=t.dimension_id order by q.created_at limit 1)
    from content_question_type t
    join visible_scope s on s.tenant_id=t.tenant_id
      and s.entity_type='question_type' and s.entity_id=t.dimension_id
)
insert into review_review_task
  (task_id, tenant_id, queue, target_type, target_id, status, payload)
select 'rvt_dim_' || substr(md5(c.tenant_id || ':' || c.target_type || ':' || c.target_id), 1, 24),
       c.tenant_id, 'content', c.target_type, c.target_id, 'pending',
       jsonb_build_object(
         'candidate', c.candidate,
         'chapter_id', c.chapter_id,
         'library_visibility', c.visibility,
         'owner_teacher_id', c.owner_teacher_id,
         'source_pipeline_id', c.source_pipeline_id,
         'backfilled', true
       )
  from candidates c
 where not exists (
   select 1 from review_review_task r
    where r.tenant_id=c.tenant_id and r.queue='content'
      and r.target_type=c.target_type and r.target_id=c.target_id
 )
on conflict do nothing;

insert into infra_schema_migration(version) values ('0026_dimension_review_backfill');
commit;
