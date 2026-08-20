-- 默认开发启动只创建运行所需身份，不预灌 K/T/Q/E/R 内容。
-- 正式内容必须由教师上传教学资料批次，经 OCR -> KTQ -> ER -> 人工复核 -> 发布得到。
-- 某次赛题可由 5 份 PDF 初始化，但文件数量和格式不是内容工坊的产品限制。
begin;

do $$
begin
  if not exists (select from pg_roles where rolname = 'agmath_app') then
    create role agmath_app login password 'agmath-app-dev-only';
  end if;
end $$;

-- 每个身份使用由部署密钥派生的独立密码；当前身份泄漏时不能切换为其他学生或内容身份。
select format('create role %I login password %L','agmath_agent_content_tnt_dev00001', :'content_password')
 where not exists (select from pg_roles where rolname='agmath_agent_content_tnt_dev00001') \gexec
select format('create role %I login password %L','agmath_agent_tnt_dev00001_usr_student01', :'student01_password')
 where not exists (select from pg_roles where rolname='agmath_agent_tnt_dev00001_usr_student01') \gexec
select format('create role %I login password %L','agmath_agent_tnt_dev00001_usr_student02', :'student02_password')
 where not exists (select from pg_roles where rolname='agmath_agent_tnt_dev00001_usr_student02') \gexec
select format('create role %I login password %L','agmath_agent_tnt_dev00001_usr_student03', :'student03_password')
 where not exists (select from pg_roles where rolname='agmath_agent_tnt_dev00001_usr_student03') \gexec
alter role agmath_agent_content_tnt_dev00001 password :'content_password';
alter role agmath_agent_tnt_dev00001_usr_student01 password :'student01_password';
alter role agmath_agent_tnt_dev00001_usr_student02 password :'student02_password';
alter role agmath_agent_tnt_dev00001_usr_student03 password :'student03_password';

grant usage on schema public to agmath_app;
grant select, insert, update, delete on all tables in schema public to agmath_app;
grant usage, select, update on all sequences in schema public to agmath_app;
grant execute on function agmath_pending_content_pipelines() to agmath_app;
grant execute on function agmath_provision_agent_identity(text,text,text,text) to agmath_app;

insert into identity_tenant(tenant_id, name)
values ('tnt_dev00001', 'Dev Tenant')
on conflict (tenant_id) do nothing;

insert into infra_agent_db_identity(db_role,tenant_id,scope_kind,subject_id) values
  ('agmath_agent_content_tnt_dev00001','tnt_dev00001','content',null),
  ('agmath_agent_tnt_dev00001_usr_student01','tnt_dev00001','teaching','usr_student01'),
  ('agmath_agent_tnt_dev00001_usr_student02','tnt_dev00001','teaching','usr_student02'),
  ('agmath_agent_tnt_dev00001_usr_student03','tnt_dev00001','teaching','usr_student03')
on conflict (db_role) do update set tenant_id=excluded.tenant_id,scope_kind=excluded.scope_kind,subject_id=excluded.subject_id;

do $$
declare r name;
begin
  foreach r in array array['agmath_agent_content_tnt_dev00001','agmath_agent_tnt_dev00001_usr_student01','agmath_agent_tnt_dev00001_usr_student02','agmath_agent_tnt_dev00001_usr_student03']::name[] loop
    execute format('revoke all on all tables in schema public from %I',r);
    execute format('grant usage on schema public to %I',r);
    execute format('grant execute on function agmath_agent_library(text,text,integer,integer) to %I',r);
    execute format('grant execute on function agmath_agent_question(text) to %I',r);
    execute format('grant execute on function agmath_agent_student_context(text) to %I',r);
    execute format('grant execute on function agmath_agent_session_context(text) to %I',r);
  end loop;
end $$;

insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)
values
  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher,content_reviewer}'),
  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student 01', '{student}'),
  ('usr_student02', 'tnt_dev00001', 'sub-student-02', 'Dev Student 02', '{student}'),
  ('usr_student03', 'tnt_dev00001', 'sub-student-03', 'Dev Student 03', '{student}')
on conflict (user_id) do nothing;

commit;
