-- 0014: 统一 Agent 壳的递归连续学习摘要，以及标准 SQL 客户端所用的受限只读数据库身份
begin;

create table runtime_learning_continuity_summary (
  summary_id          text primary key,
  tenant_id           text not null,
  run_id              text not null references runtime_assessment_run(run_id),
  source_session_id   text not null references runtime_question_session(session_id),
  previous_summary_id text references runtime_learning_continuity_summary(summary_id),
  model_id            text not null,
  prompt_version      text not null,
  payload             jsonb not null,
  created_at          timestamptz not null default now(),
  unique (run_id, source_session_id)
);
create index runtime_continuity_run_idx on runtime_learning_continuity_summary(tenant_id, run_id, created_at);
alter table runtime_learning_continuity_summary enable row level security;
create policy tenant_isolation on runtime_learning_continuity_summary
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));
create trigger forbid_mutation before update or delete on runtime_learning_continuity_summary
  for each row execute function forbid_mutation();

create table infra_agent_db_identity (
  db_role      name primary key,
  tenant_id    text not null references identity_tenant(tenant_id),
  scope_kind   text not null check (scope_kind in ('content','teaching','profile')),
  subject_id   text,
  created_at   timestamptz not null default now()
);
revoke all on infra_agent_db_identity from public;

-- Agent 身份只被授予这些安全函数，不获得正式表权限。范围由 session_user 映射得出，SQL 无 tenant 参数。
create or replace function mathpilot_agent_library(p_kind text, p_query text, p_limit integer, p_offset integer)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $$
  with scope as (
    select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity where db_role=session_user
  ), entities as (
    select 'knowledge'::text kind, dimension_id id, jsonb_build_object('id',dimension_id,'name',name,'payload',payload) item
      from public.content_knowledge_component c join scope s on s.tenant_id=c.tenant_id
    union all
    select 'question_types', dimension_id, jsonb_build_object('id',dimension_id,'name',name,'payload',payload)
      from public.content_question_type c join scope s on s.tenant_id=c.tenant_id
    union all
    select 'questions', question_id, jsonb_build_object('id',question_id,'chapter_id',chapter_id,'published',published,
      'stem_format',stem_format,'measurement_dims',measurement_dims,'payload',payload)
      from public.content_question c join scope s on s.tenant_id=c.tenant_id
     where s.scope_kind='content' or c.published
    union all
    select 'error_causes', dimension_id, jsonb_build_object('id',dimension_id,'name',name,'payload',payload)
      from public.content_error_cause c join scope s on s.tenant_id=c.tenant_id
    union all
    select 'diagnosis_rules', rule_id, jsonb_build_object('id',rule_id,'version',rule_version,'payload',payload)
      from public.content_diagnosis_rule c join scope s on s.tenant_id=c.tenant_id
  ), filtered as (
    select * from entities
     where kind=p_kind and (coalesce(p_query,'')='' or item::text ilike '%' || p_query || '%')
     order by id limit least(greatest(p_limit,1),100) + 1 offset greatest(p_offset,0)
  )
  select jsonb_build_object(
    'kind', p_kind,
    'items', coalesce((select jsonb_agg(item order by id) from (select * from filtered limit least(greatest(p_limit,1),100)) page), '[]'::jsonb),
    'next_offset', case when (select count(*) from filtered) > least(greatest(p_limit,1),100)
      then greatest(p_offset,0) + least(greatest(p_limit,1),100) else null end,
    'scope', (select jsonb_build_object('tenant_id',tenant_id,'scope_kind',scope_kind,'subject_id',subject_id) from scope),
    'resource_version', coalesce((select max(p.manifest_hash) from public.content_chapter_package p join scope s on s.tenant_id=p.tenant_id where p.published_at is not null), 'unpublished')
  )
$$;

create or replace function mathpilot_agent_question(p_question text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $$
  with scope as (select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity where db_role=session_user)
  select coalesce((
    select jsonb_build_object(
      'question_id', q.question_id, 'chapter_id', q.chapter_id, 'question_version', q.question_version,
      'stem_format', q.stem_format, 'measurement_dims', q.measurement_dims, 'published', q.published, 'payload', q.payload,
      'assets', coalesce((select jsonb_agg(jsonb_build_object('asset_id',a.asset_id,'role',a.role,'mime_type',a.mime_type,
        'content_hash',a.content_hash,'page_no',a.page_no,'bbox',a.bbox) order by a.asset_id)
        from public.content_question_asset a join scope s2 on s2.tenant_id=a.tenant_id where a.question_id=q.question_id), '[]'::jsonb),
      'targets', coalesce((select jsonb_agg(jsonb_build_object('dim',m.dim,'role',m.role,'evidence_rule',m.evidence_rule) order by m.dim)
        from public.content_measurement_target m join scope s3 on s3.tenant_id=m.tenant_id where m.question_id=q.question_id), '[]'::jsonb),
      'scope', jsonb_build_object('tenant_id',s.tenant_id,'scope_kind',s.scope_kind,'subject_id',s.subject_id)
    ) from public.content_question q join scope s on s.tenant_id=q.tenant_id
       where q.question_id=p_question and (s.scope_kind='content' or q.published)
  ), '{}'::jsonb)
$$;

create or replace function mathpilot_agent_student_context(p_student text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $$
  with scope as (
    select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity
     where db_role=session_user and scope_kind in ('teaching','profile') and (subject_id=p_student or subject_id is null)
  )
  select case when exists(select 1 from scope) then jsonb_build_object(
    'student_id', p_student,
    'scope', (select jsonb_build_object('tenant_id',tenant_id,'scope_kind',scope_kind,'subject_id',subject_id) from scope),
    'profile', (select p.payload from public.state_student_profile p join scope s on s.tenant_id=p.tenant_id where p.student_id=p_student),
    'snapshot', (select p.payload from public.state_student_snapshot p join scope s on s.tenant_id=p.tenant_id where p.student_id=p_student order by p.published_at desc limit 1),
    'mastery', coalesce((select jsonb_agg(jsonb_build_object('dimension_id',dimension_id,'p_profile',p_profile,'state',state) order by dimension_id)
      from public.state_mastery_state p join scope s on s.tenant_id=p.tenant_id where p.student_id=p_student), '[]'::jsonb),
    'retention', coalesce((select jsonb_agg(jsonb_build_object('dimension_id',dimension_id,'next_review_due',next_review_due,'stable',stable) order by dimension_id)
      from public.state_retention_state p join scope s on s.tenant_id=p.tenant_id where p.student_id=p_student), '[]'::jsonb),
    'misconceptions', coalesce((select jsonb_agg(jsonb_build_object('error_cause_id',error_cause_id,'state',state,'evidence_refs',evidence_refs) order by error_cause_id)
      from public.state_misconception_state p join scope s on s.tenant_id=p.tenant_id where p.student_id=p_student), '[]'::jsonb)
  ) else '{}'::jsonb end
$$;

create or replace function mathpilot_agent_session_context(p_session text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
as $$
  with scope as (
    select tenant_id,scope_kind,subject_id from public.infra_agent_db_identity
     where db_role=session_user and scope_kind in ('teaching','profile')
  )
  select coalesce((
    select jsonb_build_object(
      'session', q.payload || jsonb_build_object('state',q.state,'hint_level',q.hint_level,'probe_rounds',q.probe_rounds),
      'attempts', coalesce((select jsonb_agg(a.payload order by a.created_at) from public.runtime_attempt a
        join scope s2 on s2.tenant_id=a.tenant_id where a.session_id=p_session), '[]'::jsonb),
      'verdicts', coalesce((select jsonb_agg(v.payload order by v.created_at) from public.runtime_answer_verdict v
        join scope s2 on s2.tenant_id=v.tenant_id where v.session_id=p_session), '[]'::jsonb),
      'chat', coalesce((select jsonb_agg(jsonb_build_object('role',t.role,'payload',t.payload,'created_at',t.created_at) order by t.turn)
        from public.runtime_chat_turn t join scope s2 on s2.tenant_id=t.tenant_id where t.session_id=p_session), '[]'::jsonb),
      'ser', (select r.payload from public.state_scientific_evaluation_report r join scope s2 on s2.tenant_id=r.tenant_id where r.session_id=p_session order by r.created_at desc limit 1),
      'tss', (select r.payload from public.runtime_teaching_session_summary r join scope s2 on s2.tenant_id=r.tenant_id where r.session_id=p_session order by r.created_at desc limit 1),
      'scope', jsonb_build_object('tenant_id',s.tenant_id,'scope_kind',s.scope_kind,'subject_id',s.subject_id)
    ) from public.runtime_question_session q join scope s on s.tenant_id=q.tenant_id
       where q.session_id=p_session and (s.subject_id is null or s.subject_id=q.student_id)
  ), '{}'::jsonb)
$$;

revoke all on function mathpilot_agent_library(text,text,integer,integer) from public;
revoke all on function mathpilot_agent_question(text) from public;
revoke all on function mathpilot_agent_student_context(text) from public;
revoke all on function mathpilot_agent_session_context(text) from public;

insert into infra_schema_migration(version) values ('0014_agent_shell_continuity');
commit;
