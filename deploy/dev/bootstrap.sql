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
grant execute on function mathpilot_pending_content_pipelines() to mathpilot_app;
grant execute on function mathpilot_provision_agent_identity(text,text,text,text) to mathpilot_app;
grant execute on function mathpilot_content_entity_visible(text,text,text[],text,text,boolean) to mathpilot_app;
grant execute on function mathpilot_content_package_visible(text,text,text[],text,boolean) to mathpilot_app;
grant execute on function mathpilot_content_candidate_visible(text,text,text[],text) to mathpilot_app;
grant execute on function mathpilot_content_can_publish_package(text,text,text[],text,text) to mathpilot_app;
grant execute on function mathpilot_pending_er_start_commands() to mathpilot_app;
grant execute on function mathpilot_pending_review_feedback_commands() to mathpilot_app;

-- Runtime grants are owned by migrations. Reassert the storage boundary for
-- databases previously bootstrapped with the retired blanket application
-- grant, without restoring broad access for newly added tables.
revoke all on storage_object,storage_object_claim from mathpilot_app;
revoke execute on function mathpilot_storage_begin_deletions(text,integer) from mathpilot_app;
revoke execute on function mathpilot_storage_finish_deletion(text,text) from mathpilot_app;
revoke execute on function mathpilot_storage_retry_deletion(text,text,text) from mathpilot_app;
revoke all on content_candidate_source_object,content_candidate_source_seal from mathpilot_app;
revoke update,delete on content_candidate_set from mathpilot_app;
grant update(status,decided_at) on content_candidate_set to mathpilot_app;
revoke update,delete on content_field_provenance from mathpilot_app;
grant update(review_decision) on content_field_provenance to mathpilot_app;
revoke update,delete on content_source from mathpilot_app;
revoke insert,update,delete on content_source_page from mathpilot_app;
revoke insert,update,delete on content_package from mathpilot_app;
revoke all on science_v3_message_attachment,identity_user_avatar from mathpilot_app;
grant select on science_v3_message_attachment,identity_user_avatar to mathpilot_app;
grant select on content_candidate_source_object to mathpilot_app;
grant insert(package_id,tenant_id,origin,owner_teacher_user_id,title,version_no,status,
             manifest_sha256,approved_er_candidate_set_id,created_at)
  on content_package to mathpilot_app;
grant update(status) on content_package to mathpilot_app;
revoke execute on function mathpilot_storage_claim_owned_object(text,text,text,text,text,text) from mathpilot_app;
revoke execute on function mathpilot_storage_release_owned_claim(text,text,text,text,text) from mathpilot_app;
revoke execute on function mathpilot_content_claim_candidate_audit_object(text,text,text,text,text) from mathpilot_app;
grant execute on function mathpilot_content_bind_candidate_source_object(text,text,text,text,text,text,text) to mathpilot_app;
grant usage on schema public to mathpilot_storage;
grant select on infra_schema_migration,science_v3_message_attachment to mathpilot_storage;
grant select,insert,update on storage_object to mathpilot_storage;
revoke all on storage_object_claim from mathpilot_storage;
grant execute on function mathpilot_science_v3_current_actor_students(text,boolean) to mathpilot_storage;
grant execute on function mathpilot_science_v3_current_actor_thread(text,text,boolean) to mathpilot_storage;
grant execute on function mathpilot_storage_begin_deletions(text,integer) to mathpilot_storage;
grant execute on function mathpilot_storage_finish_deletion(text,text) to mathpilot_storage;
grant execute on function mathpilot_storage_retry_deletion(text,text,text) to mathpilot_storage;
grant execute on function mathpilot_storage_request_owned_deletion(text,text,text,text[]) to mathpilot_storage;

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

-- science-v3 keeps login and student fact identities distinct. These are
-- explicit development subjects, not a backfill from legacy learning rows.
insert into science_v3_student(student_id,tenant_id,user_id) values
  ('stu_student01','tnt_dev00001','usr_student01'),
  ('stu_student02','tnt_dev00001','usr_student02'),
  ('stu_student03','tnt_dev00001','usr_student03')
on conflict (tenant_id,user_id) do nothing;

commit;
