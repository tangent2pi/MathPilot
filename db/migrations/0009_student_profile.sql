-- 0009: 学生最小画像（设计 §3.1）——自报资料（可更新，非不可变事件）
-- 画像采集只影响首轮选题覆盖与计划优先级，不直接写"掌握/薄弱"（§3.1-3）
begin;

create table state_student_profile (
  student_id    text primary key,
  tenant_id     text not null,
  grade         text not null,
  current_score integer check (current_score between 0 and 150),
  target_score  integer check (target_score between 0 and 150),
  weekly_hours  text not null check (weekly_hours in ('1-3','4-6','7-10','10+')),
  self_weak     text[] not null default '{}',
  device_draft  text not null check (device_draft in ('触屏手写','纸面拍照','无草稿')),
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 新增表须自行启用 RLS 并授权（0006 的批量 do-block 只覆盖当时已存在的表；迁移只追加不修改）
alter table state_student_profile enable row level security;
create policy tenant_isolation on state_student_profile
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

-- 应用角色属于部署配置，可能尚未在全新数据库中创建；权限统一由
-- deploy/dev/bootstrap.sql 在全部迁移完成后授予。

insert into infra_schema_migration(version) values ('0009_student_profile');
commit;
