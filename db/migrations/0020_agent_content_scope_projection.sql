-- 0020: Agent 只读投影用 EXISTS 计算授权，避免一个实体有多条范围授权时重复或标量子查询报错。
begin;

create or replace function mathpilot_agent_library(p_kind text,p_query text,p_limit integer,p_offset integer)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public
as $$
  with scope as (
    select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity where db_role=session_user
  ), entities as (
    select 'knowledge'::text kind,c.dimension_id id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload) item
      from public.content_knowledge_component c join scope i on i.tenant_id=c.tenant_id
     where exists(select 1 from public.content_entity_scope s
       where s.tenant_id=c.tenant_id and s.entity_type='knowledge_component' and s.entity_id=c.dimension_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))
    union all
    select 'question_types',c.dimension_id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload)
      from public.content_question_type c join scope i on i.tenant_id=c.tenant_id
     where exists(select 1 from public.content_entity_scope s
       where s.tenant_id=c.tenant_id and s.entity_type='question_type' and s.entity_id=c.dimension_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))
    union all
    select 'questions',c.question_id,jsonb_build_object('id',c.question_id,'chapter_id',c.chapter_id,'published',c.published,
      'stem_format',c.stem_format,'measurement_dims',c.measurement_dims,'payload',c.payload)
      from public.content_question c join scope i on i.tenant_id=c.tenant_id
     where (i.scope_kind='content' or c.published) and exists(select 1 from public.content_entity_scope s
       where s.tenant_id=c.tenant_id and s.entity_type='question' and s.entity_id=c.question_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))
    union all
    select 'error_causes',c.dimension_id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload)
      from public.content_error_cause c join scope i on i.tenant_id=c.tenant_id
     where exists(select 1 from public.content_entity_scope s
       where s.tenant_id=c.tenant_id and s.entity_type='error_cause' and s.entity_id=c.dimension_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))
    union all
    select 'diagnosis_rules',c.rule_id,jsonb_build_object('id',c.rule_id,'version',c.rule_version,'payload',c.payload)
      from public.content_diagnosis_rule c join scope i on i.tenant_id=c.tenant_id
     where exists(select 1 from public.content_entity_scope s
       where s.tenant_id=c.tenant_id and s.entity_type='diagnosis_rule' and s.entity_id=c.rule_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))
  ), filtered as (
    select * from entities where kind=p_kind
      and (coalesce(p_query,'')='' or item::text ilike '%'||p_query||'%')
    order by id limit least(greatest(p_limit,1),100)+1 offset greatest(p_offset,0)
  )
  select jsonb_build_object(
    'kind',p_kind,
    'items',coalesce((select jsonb_agg(item order by id) from (select * from filtered limit least(greatest(p_limit,1),100)) page),'[]'::jsonb),
    'next_offset',case when (select count(*) from filtered)>least(greatest(p_limit,1),100)
      then greatest(p_offset,0)+least(greatest(p_limit,1),100) else null end,
    'scope',(select jsonb_build_object('tenant_id',tenant_id,'scope_kind',scope_kind,'subject_id',subject_id) from scope),
    'resource_version',coalesce((select max(p.manifest_hash) from public.content_chapter_package p join scope i on i.tenant_id=p.tenant_id
      where p.published_at is not null and exists(select 1 from public.content_entity_scope s
        where s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
          and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))),'unpublished'))
$$;

create or replace function mathpilot_agent_question(p_question text)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public
as $$
  with scope as (select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity where db_role=session_user)
  select coalesce((select jsonb_build_object(
    'question_id',q.question_id,'chapter_id',q.chapter_id,'question_version',q.question_version,
    'stem_format',q.stem_format,'measurement_dims',q.measurement_dims,'published',q.published,'payload',q.payload,
    'assets',coalesce((select jsonb_agg(jsonb_build_object('asset_id',a.asset_id,'role',a.role,'mime_type',a.mime_type,
      'content_hash',a.content_hash,'page_no',a.page_no,'bbox',a.bbox) order by a.asset_id)
      from public.content_question_asset a where a.question_id=q.question_id),'[]'::jsonb),
    'targets',coalesce((select jsonb_agg(jsonb_build_object('dim',m.dim,'role',m.role,'evidence_rule',m.evidence_rule) order by m.dim)
      from public.content_measurement_target m where m.question_id=q.question_id),'[]'::jsonb),
    'scope',jsonb_build_object('tenant_id',i.tenant_id,'scope_kind',i.scope_kind,'subject_id',i.subject_id)
  ) from public.content_question q join scope i on i.tenant_id=q.tenant_id
   where q.question_id=p_question and (i.scope_kind='content' or q.published)
     and exists(select 1 from public.content_entity_scope s
       where s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
         and public.mathpilot_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id))), '{}'::jsonb)
$$;

insert into infra_schema_migration(version) values ('0020_agent_content_scope_projection');
commit;
