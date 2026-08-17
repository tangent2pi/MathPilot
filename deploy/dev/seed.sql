-- dev 种子：最小权限应用账号 + dev 租户/用户（仅组合根使用）
begin;

do $$
begin
  if not exists (select from pg_roles where rolname = 'agmath_app') then
    create role agmath_app login password 'agmath-app-dev-only';
  end if;
end $$;
grant usage on schema public to agmath_app;
grant select, insert, update, delete on all tables in schema public to agmath_app;

insert into identity_tenant(tenant_id, name)
values ('tnt_dev00001', 'Dev Tenant')
on conflict (tenant_id) do nothing;

insert into identity_user(user_id, tenant_id, oidc_sub, display_name, roles)
values
  ('usr_teacher01', 'tnt_dev00001', 'sub-teacher-dev', 'Dev Teacher', '{teacher,content_reviewer}'),
  ('usr_student01', 'tnt_dev00001', 'sub-student-dev', 'Dev Student', '{student}')
on conflict (user_id) do nothing;

commit;
