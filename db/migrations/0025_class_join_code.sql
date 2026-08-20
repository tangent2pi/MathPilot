-- 0025: 教师创建班级并通过班级码邀请学生。
-- 班级码是面向用户的短期邀请凭据；教师可随时轮换，学生加入后仍由
-- identity_teacher_student_binding 作为内容与学习数据权限的唯一依据。
begin;

alter table identity_class
  add column join_code text,
  add column join_code_updated_at timestamptz not null default now();

update identity_class
   set join_code = upper(substr(md5(tenant_id || ':' || class_id), 1, 8))
 where join_code is null;

alter table identity_class alter column join_code set not null;
alter table identity_class add constraint identity_class_join_code_format
  check (join_code ~ '^[A-Z0-9]{6,12}$');
create unique index identity_class_join_code_unique
  on identity_class(tenant_id, join_code);

insert into infra_schema_migration(version) values ('0025_class_join_code');
commit;
