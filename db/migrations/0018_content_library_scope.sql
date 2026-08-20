-- 0018: 公共内容库、教师内容库与学生绑定范围。
-- 浏览器、领域服务和 Agent SQL 身份必须由同一组范围事实决定可见内容。
begin;

create table identity_teacher_student_binding (
  binding_id    text primary key,
  tenant_id     text not null references identity_tenant(tenant_id),
  teacher_id    text not null references identity_user(user_id),
  student_id    text not null references identity_user(user_id),
  status        text not null check (status in ('active','revoked')),
  created_by    text not null references identity_user(user_id),
  created_at    timestamptz not null default now(),
  revoked_by    text references identity_user(user_id),
  revoked_at    timestamptz,
  payload       jsonb not null default '{}'::jsonb,
  check (teacher_id <> student_id),
  check ((status='active' and revoked_at is null) or (status='revoked' and revoked_at is not null))
);
create unique index identity_one_active_teacher_per_student
  on identity_teacher_student_binding(tenant_id,student_id) where status='active';
create index identity_binding_teacher_idx
  on identity_teacher_student_binding(tenant_id,teacher_id,status,created_at desc);
alter table identity_teacher_student_binding enable row level security;
create policy tenant_isolation on identity_teacher_student_binding
  using (tenant_id=current_setting('app.current_tenant',true))
  with check (tenant_id=current_setting('app.current_tenant',true));

create table content_entity_scope (
  tenant_id       text not null references identity_tenant(tenant_id),
  entity_type     text not null check (entity_type in
    ('knowledge_component','question_type','error_cause','diagnosis_rule','question','chapter_package')),
  entity_id       text not null,
  visibility      text not null check (visibility in ('public','teacher')),
  owner_teacher_id text references identity_user(user_id),
  source_pipeline_id text,
  created_at      timestamptz not null default now(),
  check ((visibility='public' and owner_teacher_id is null)
      or (visibility='teacher' and owner_teacher_id is not null))
);
create unique index content_entity_scope_grant_unique
  on content_entity_scope
  (tenant_id,entity_type,entity_id,visibility,owner_teacher_id) nulls not distinct;
create index content_entity_scope_visible_idx
  on content_entity_scope(tenant_id,visibility,owner_teacher_id,entity_type);
alter table content_entity_scope enable row level security;
create policy tenant_isolation on content_entity_scope
  using (tenant_id=current_setting('app.current_tenant',true))
  with check (tenant_id=current_setting('app.current_tenant',true));

create table content_source_document_grant (
  tenant_id       text not null references identity_tenant(tenant_id),
  document_id     text not null references content_source_document(document_id),
  visibility      text not null check (visibility in ('public','teacher')),
  owner_teacher_id text references identity_user(user_id),
  created_at      timestamptz not null default now(),
  check ((visibility='public' and owner_teacher_id is null)
      or (visibility='teacher' and owner_teacher_id is not null))
);
create unique index content_source_document_grant_unique
  on content_source_document_grant
  (tenant_id,document_id,visibility,owner_teacher_id) nulls not distinct;
alter table content_source_document_grant enable row level security;
create policy tenant_isolation on content_source_document_grant
  using (tenant_id=current_setting('app.current_tenant',true))
  with check (tenant_id=current_setting('app.current_tenant',true));

alter table content_pipeline_run
  add column library_visibility text not null default 'teacher'
    check (library_visibility in ('public','teacher')),
  add column owner_teacher_id text references identity_user(user_id);
update content_pipeline_run set owner_teacher_id=created_by where library_visibility='teacher';
alter table content_pipeline_run add constraint content_pipeline_scope_owner_check
  check ((library_visibility='public' and owner_teacher_id is null)
      or (library_visibility='teacher' and owner_teacher_id is not null));

drop function agmath_pending_content_pipelines();
create function agmath_pending_content_pipelines()
returns table (
  run_id text,tenant_id text,created_by text,chapter_id text,document_ids jsonb,
  ktq_session_ref text,er_session_ref text,stage text,
  library_visibility text,owner_teacher_id text
)
language sql stable security definer
set search_path=pg_catalog,public
as $$
  select p.run_id,p.tenant_id,p.created_by,p.chapter_id,p.document_ids,
         p.ktq_session_ref,p.er_session_ref,p.stage,p.library_visibility,p.owner_teacher_id
    from public.content_pipeline_run p
   where p.status in ('queued','running') order by p.created_at
$$;
revoke all on function agmath_pending_content_pipelines() from public;

-- 旧数据没有范围元数据：已发布内容按公共库迁移；未发布的流水线候选归创建教师。
insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
select q.tenant_id,'question',q.question_id,
       case when q.published then 'public' else 'teacher' end,
       case when q.published then null else coalesce(p.created_by,
         (select u.user_id from identity_user u where u.tenant_id=q.tenant_id and u.roles && array['teacher','tenant_admin']::text[] order by u.created_at limit 1)) end,
       p.run_id
  from content_question q
  left join lateral (select run_id,created_by from content_pipeline_run p where p.tenant_id=q.tenant_id and p.chapter_id=q.chapter_id order by p.created_at desc limit 1) p on true
 where q.published or p.created_by is not null
on conflict do nothing;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
select k.tenant_id,'knowledge_component',k.dimension_id,
       case when bool_or(coalesce(s.visibility='public',false)) then 'public' else 'teacher' end,
       case when bool_or(coalesce(s.visibility='public',false)) then null else min(s.owner_teacher_id) end,
       min(s.source_pipeline_id)
  from content_knowledge_component k
  left join content_measurement_target mt on mt.dim=k.dimension_id
  left join content_entity_scope s on s.tenant_id=k.tenant_id and s.entity_type='question' and s.entity_id=mt.question_id
 group by k.tenant_id,k.dimension_id
having bool_or(coalesce(s.visibility='public',false)) or min(s.owner_teacher_id) is not null
on conflict do nothing;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
select t.tenant_id,'question_type',t.dimension_id,
       case when bool_or(coalesce(s.visibility='public',false)) then 'public' else 'teacher' end,
       case when bool_or(coalesce(s.visibility='public',false)) then null else min(s.owner_teacher_id) end,
       min(s.source_pipeline_id)
  from content_question_type t
  left join content_measurement_target mt on mt.dim=t.dimension_id
  left join content_entity_scope s on s.tenant_id=t.tenant_id and s.entity_type='question' and s.entity_id=mt.question_id
 group by t.tenant_id,t.dimension_id
having bool_or(coalesce(s.visibility='public',false)) or min(s.owner_teacher_id) is not null
on conflict do nothing;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
select e.tenant_id,'error_cause',e.dimension_id,
       case when exists(select 1 from content_chapter_package cp
         where cp.tenant_id=e.tenant_id and cp.published_at is not null
           and cp.payload->'contents'->'error_causes' ? e.dimension_id) then 'public' else 'teacher' end,
       case when exists(select 1 from content_chapter_package cp
         where cp.tenant_id=e.tenant_id and cp.published_at is not null
           and cp.payload->'contents'->'error_causes' ? e.dimension_id) then null else p.created_by end,
       p.run_id
  from content_error_cause e
  left join lateral (select run_id,created_by from content_pipeline_run p
    where p.tenant_id=e.tenant_id and p.chapter_id=e.payload->>'chapter_id' order by p.created_at desc limit 1) p on true
 where p.created_by is not null or exists(select 1 from content_chapter_package cp
   where cp.tenant_id=e.tenant_id and cp.published_at is not null and cp.payload->'contents'->'error_causes' ? e.dimension_id)
on conflict do nothing;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
select r.tenant_id,'diagnosis_rule',r.rule_id,
       case when exists(select 1 from content_chapter_package cp
         where cp.tenant_id=r.tenant_id and cp.published_at is not null
           and cp.payload->'contents'->'diagnosis_rules' ? r.rule_id) then 'public' else 'teacher' end,
       case when exists(select 1 from content_chapter_package cp
         where cp.tenant_id=r.tenant_id and cp.published_at is not null
           and cp.payload->'contents'->'diagnosis_rules' ? r.rule_id) then null else p.created_by end,
       p.run_id
  from content_diagnosis_rule r
  left join lateral (select run_id,created_by from content_pipeline_run p
    where p.tenant_id=r.tenant_id and p.chapter_id=r.payload->>'chapter_id' order by p.created_at desc limit 1) p on true
 where p.created_by is not null or exists(select 1 from content_chapter_package cp
   where cp.tenant_id=r.tenant_id and cp.published_at is not null and cp.payload->'contents'->'diagnosis_rules' ? r.rule_id)
on conflict do nothing;

insert into content_entity_scope(tenant_id,entity_type,entity_id,visibility,owner_teacher_id)
select p.tenant_id,'chapter_package',p.package_id,'public',null from content_chapter_package p
on conflict do nothing;

insert into content_source_document_grant(tenant_id,document_id,visibility,owner_teacher_id)
select distinct p.tenant_id,d.value::text,'teacher',p.created_by
  from content_pipeline_run p cross join lateral jsonb_array_elements_text(p.document_ids) d(value)
on conflict do nothing;

-- 判断某个 Agent 身份是否可以读取实体范围。教学身份按学生当前有效绑定推导教师库。
create or replace function agmath_agent_scope_visible(p_visibility text,p_owner text,p_scope_kind text,p_subject text,p_tenant text)
returns boolean language sql stable security definer
set search_path=pg_catalog,public
as $$
  select p_visibility='public'
      or (p_scope_kind='content' and p_owner=p_subject)
      or (p_scope_kind in ('teaching','profile') and exists(
        select 1 from public.identity_teacher_student_binding b
         where b.tenant_id=p_tenant and b.student_id=p_subject and b.teacher_id=p_owner and b.status='active'))
$$;
revoke all on function agmath_agent_scope_visible(text,text,text,text,text) from public;

create or replace function agmath_agent_library(p_kind text,p_query text,p_limit integer,p_offset integer)
returns jsonb language sql stable security definer
set search_path=pg_catalog,public
as $$
  with scope as (
    select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity where db_role=session_user
  ), entities as (
    select 'knowledge'::text kind,c.dimension_id id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload) item
      from public.content_knowledge_component c join scope i on i.tenant_id=c.tenant_id
      join public.content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='knowledge_component' and s.entity_id=c.dimension_id
     where public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)
    union all
    select 'question_types',c.dimension_id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload)
      from public.content_question_type c join scope i on i.tenant_id=c.tenant_id
      join public.content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='question_type' and s.entity_id=c.dimension_id
     where public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)
    union all
    select 'questions',c.question_id,jsonb_build_object('id',c.question_id,'chapter_id',c.chapter_id,'published',c.published,
      'stem_format',c.stem_format,'measurement_dims',c.measurement_dims,'payload',c.payload)
      from public.content_question c join scope i on i.tenant_id=c.tenant_id
      join public.content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='question' and s.entity_id=c.question_id
     where (i.scope_kind='content' or c.published)
       and public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)
    union all
    select 'error_causes',c.dimension_id,jsonb_build_object('id',c.dimension_id,'name',c.name,'payload',c.payload)
      from public.content_error_cause c join scope i on i.tenant_id=c.tenant_id
      join public.content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='error_cause' and s.entity_id=c.dimension_id
     where public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)
    union all
    select 'diagnosis_rules',c.rule_id,jsonb_build_object('id',c.rule_id,'version',c.rule_version,'payload',c.payload)
      from public.content_diagnosis_rule c join scope i on i.tenant_id=c.tenant_id
      join public.content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='diagnosis_rule' and s.entity_id=c.rule_id
     where public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)
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
    'resource_version',coalesce((select max(p.manifest_hash) from public.content_chapter_package p
      join scope i on i.tenant_id=p.tenant_id join public.content_entity_scope s on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
      where p.published_at is not null and public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)),'unpublished'))
$$;

create or replace function agmath_agent_question(p_question text)
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
    join public.content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
   where q.question_id=p_question and (i.scope_kind='content' or q.published)
     and public.agmath_agent_scope_visible(s.visibility,s.owner_teacher_id,i.scope_kind,i.subject_id,i.tenant_id)), '{}'::jsonb)
$$;

-- Runtime 只提交已经由部署主密钥派生的密码；函数按领域主体计算角色名并限制主体类型。
create or replace function agmath_provision_agent_identity(p_tenant text,p_scope_kind text,p_subject text,p_password text)
returns name language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_role name; v_roles text[];
begin
  select u.roles into v_roles from public.identity_user u where u.tenant_id=p_tenant and u.user_id=p_subject;
  if v_roles is null then raise exception 'unknown agent subject'; end if;
  if p_scope_kind='content' and not (v_roles && array['teacher','content_reviewer','tenant_admin']::text[]) then
    raise exception 'content agent subject must be a teacher';
  end if;
  if p_scope_kind in ('teaching','profile') and not (v_roles && array['student']::text[]) then
    raise exception 'teaching agent subject must be a student';
  end if;
  if p_scope_kind not in ('content','teaching','profile') then raise exception 'invalid agent scope'; end if;
  v_role := case when p_scope_kind='content'
    then ('agmath_agent_content_'||regexp_replace(p_tenant,'[^A-Za-z0-9_]','','g')||'_'||regexp_replace(p_subject,'[^A-Za-z0-9_]','','g'))::name
    else ('agmath_agent_'||regexp_replace(p_tenant,'[^A-Za-z0-9_]','','g')||'_'||regexp_replace(p_subject,'[^A-Za-z0-9_]','','g'))::name end;
  if not exists(select 1 from pg_roles where rolname=v_role) then execute format('create role %I login password %L',v_role,p_password);
  else execute format('alter role %I password %L',v_role,p_password); end if;
  insert into public.infra_agent_db_identity(db_role,tenant_id,scope_kind,subject_id)
    values(v_role,p_tenant,p_scope_kind,p_subject)
    on conflict(db_role) do update set tenant_id=excluded.tenant_id,scope_kind=excluded.scope_kind,subject_id=excluded.subject_id;
  execute format('revoke all on all tables in schema public from %I',v_role);
  execute format('grant usage on schema public to %I',v_role);
  execute format('grant execute on function public.agmath_agent_library(text,text,integer,integer) to %I',v_role);
  execute format('grant execute on function public.agmath_agent_question(text) to %I',v_role);
  execute format('grant execute on function public.agmath_agent_student_context(text) to %I',v_role);
  execute format('grant execute on function public.agmath_agent_session_context(text) to %I',v_role);
  return v_role;
end
$$;
revoke all on function agmath_provision_agent_identity(text,text,text,text) from public;

insert into infra_schema_migration(version) values ('0018_content_library_scope');
commit;
