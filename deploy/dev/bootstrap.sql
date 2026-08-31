-- 默认开发启动只创建运行所需身份；官方初始 K/T/Q/E/R 由审核过的
-- db/migration-data 清单单独导入，不由 bootstrap 或旧 fixture 隐式灌入。
-- 后续教师内容仍经资料上传 -> KTQ -> ER -> 人工复核 -> 班级发布得到。
begin;

select format('create role %I login password %L','mathpilot_app', :'app_password')
 where not exists (select from pg_roles where rolname='mathpilot_app') \gexec
alter role mathpilot_app password :'app_password';

-- 每个身份使用由部署密钥派生的独立密码；当前身份泄漏时不能切换为其他学生或内容身份。
select format('create role %I login password %L','mathpilot_agent_content_tnt_dev00001', :'content_password')
 where not exists (select from pg_roles where rolname='mathpilot_agent_content_tnt_dev00001') \gexec
select format('create role %I login password %L','mathpilot_agent_tnt_dev00001_usr_student01', :'student01_password')
 where not exists (select from pg_roles where rolname='mathpilot_agent_tnt_dev00001_usr_student01') \gexec
select format('create role %I login password %L','mathpilot_agent_tnt_dev00001_usr_student02', :'student02_password')
 where not exists (select from pg_roles where rolname='mathpilot_agent_tnt_dev00001_usr_student02') \gexec
select format('create role %I login password %L','mathpilot_agent_tnt_dev00001_usr_student03', :'student03_password')
 where not exists (select from pg_roles where rolname='mathpilot_agent_tnt_dev00001_usr_student03') \gexec
alter role mathpilot_agent_content_tnt_dev00001 password :'content_password';
alter role mathpilot_agent_tnt_dev00001_usr_student01 password :'student01_password';
alter role mathpilot_agent_tnt_dev00001_usr_student02 password :'student02_password';
alter role mathpilot_agent_tnt_dev00001_usr_student03 password :'student03_password';

grant usage on schema public to mathpilot_app;
grant select, insert, update, delete on all tables in schema public to mathpilot_app;
grant usage, select, update on all sequences in schema public to mathpilot_app;
grant execute on function mathpilot_pending_content_pipelines() to mathpilot_app;
grant execute on function mathpilot_provision_agent_identity(text,text,text,text) to mathpilot_app;
grant execute on function mathpilot_content_entity_visible(text,text,text[],text,text,boolean) to mathpilot_app;
grant execute on function mathpilot_content_package_visible(text,text,text[],text,boolean) to mathpilot_app;
grant execute on function mathpilot_content_candidate_visible(text,text,text[],text) to mathpilot_app;
grant execute on function mathpilot_content_can_publish_package(text,text,text[],text,text) to mathpilot_app;
grant execute on function mathpilot_pending_er_start_commands() to mathpilot_app;
grant execute on function mathpilot_pending_review_feedback_commands() to mathpilot_app;

insert into identity_tenant(tenant_id, name)
values ('tnt_dev00001', 'Dev Tenant')
on conflict (tenant_id) do nothing;

insert into infra_agent_db_identity(db_role,tenant_id,scope_kind,subject_id) values
  ('mathpilot_agent_content_tnt_dev00001','tnt_dev00001','content',null),
  ('mathpilot_agent_tnt_dev00001_usr_student01','tnt_dev00001','teaching','usr_student01'),
  ('mathpilot_agent_tnt_dev00001_usr_student02','tnt_dev00001','teaching','usr_student02'),
  ('mathpilot_agent_tnt_dev00001_usr_student03','tnt_dev00001','teaching','usr_student03')
on conflict (db_role) do update set tenant_id=excluded.tenant_id,scope_kind=excluded.scope_kind,subject_id=excluded.subject_id;

do $$
declare r name;
begin
  foreach r in array array['mathpilot_agent_content_tnt_dev00001','mathpilot_agent_tnt_dev00001_usr_student01','mathpilot_agent_tnt_dev00001_usr_student02','mathpilot_agent_tnt_dev00001_usr_student03']::name[] loop
    execute format('revoke all on all tables in schema public from %I',r);
    execute format('grant usage on schema public to %I',r);
    execute format('grant execute on function mathpilot_agent_library(text,text,integer,integer) to %I',r);
    execute format('grant execute on function mathpilot_agent_question(text) to %I',r);
    execute format('grant execute on function mathpilot_agent_student_context(text) to %I',r);
    execute format('grant execute on function mathpilot_agent_session_context(text) to %I',r);
  end loop;
end $$;

insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)
values
  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher}'),
  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student 01', '{student}'),
  ('usr_student02', 'tnt_dev00001', 'sub-student-02', 'Dev Student 02', '{student}'),
  ('usr_student03', 'tnt_dev00001', 'sub-student-03', 'Dev Student 03', '{student}')
on conflict (user_id) do nothing;

-- 0031 的规范化角色关系是 next 域的事实源。bootstrap 在迁移之后执行，
-- 因此不能依赖用户第一次登录才补这几行。
insert into identity_user_role(tenant_id, user_id, role, assigned_by_user_id)
select u.tenant_id, u.user_id, r.role, null
  from identity_user u
  cross join lateral unnest(u.roles) as r(role)
 where r.role in ('teacher', 'student')
on conflict (user_id, role) do nothing;

commit;
