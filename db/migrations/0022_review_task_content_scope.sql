-- 0022: 为范围模型上线前已创建的内容复核任务补齐所属内容库。
-- 新任务由 content-service 在创建时直接写入这些字段；本迁移只修复历史任务，
-- 使教师刷新页面后仍能看到本人尚未完成的复核工作。
begin;

with inferred_scope as (
  select distinct on (r.task_id)
         r.task_id,
         s.visibility,
         s.owner_teacher_id,
         s.source_pipeline_id
    from review_review_task r
    join content_entity_scope s
      on s.tenant_id = r.tenant_id
     and s.entity_type = r.target_type
     and s.entity_id = r.target_id
    left join content_pipeline_run p
      on p.tenant_id = s.tenant_id
     and p.run_id = s.source_pipeline_id
   where r.queue = 'content'
     and not (r.payload ? 'library_visibility')
   order by r.task_id,
            (p.chapter_id = r.payload->>'chapter_id') desc nulls last,
            s.created_at desc
)
update review_review_task r
   set payload = r.payload || jsonb_build_object(
     'library_visibility', i.visibility,
     'owner_teacher_id', i.owner_teacher_id,
     'source_pipeline_id', i.source_pipeline_id
   )
  from inferred_scope i
 where r.task_id = i.task_id;

insert into infra_schema_migration(version) values ('0022_review_task_content_scope');
commit;
