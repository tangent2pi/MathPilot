-- 0021: Agent 数据库身份的领域主体必须与任务角色匹配。
begin;

create or replace function mathpilot_provision_agent_identity(p_tenant text,p_scope_kind text,p_subject text,p_password text)
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
    then ('mathpilot_agent_content_'||regexp_replace(p_tenant,'[^A-Za-z0-9_]','','g')||'_'||regexp_replace(p_subject,'[^A-Za-z0-9_]','','g'))::name
    else ('mathpilot_agent_'||regexp_replace(p_tenant,'[^A-Za-z0-9_]','','g')||'_'||regexp_replace(p_subject,'[^A-Za-z0-9_]','','g'))::name end;
  if not exists(select 1 from pg_roles where rolname=v_role) then execute format('create role %I login password %L',v_role,p_password);
  else execute format('alter role %I password %L',v_role,p_password); end if;
  insert into public.infra_agent_db_identity(db_role,tenant_id,scope_kind,subject_id)
    values(v_role,p_tenant,p_scope_kind,p_subject)
    on conflict(db_role) do update set tenant_id=excluded.tenant_id,scope_kind=excluded.scope_kind,subject_id=excluded.subject_id;
  execute format('revoke all on all tables in schema public from %I',v_role);
  execute format('grant usage on schema public to %I',v_role);
  execute format('grant execute on function public.mathpilot_agent_library(text,text,integer,integer) to %I',v_role);
  execute format('grant execute on function public.mathpilot_agent_question(text) to %I',v_role);
  execute format('grant execute on function public.mathpilot_agent_student_context(text) to %I',v_role);
  execute format('grant execute on function public.mathpilot_agent_session_context(text) to %I',v_role);
  return v_role;
end
$$;
revoke all on function mathpilot_provision_agent_identity(text,text,text,text) from public;

insert into infra_schema_migration(version) values ('0021_agent_identity_subject_roles');
commit;
