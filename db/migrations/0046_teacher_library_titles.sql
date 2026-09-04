-- 0046: 教师私有资料库显示名（重命名）。
-- 批次（候选集）新增 display_name，包沿用 content_package.title。
begin;

alter table content_candidate_set
  add column if not exists display_name text;

create index if not exists content_candidate_set_display_name_idx
  on content_candidate_set (tenant_id, owner_teacher_user_id, display_name);

insert into infra_schema_migration(version) values ('0046_teacher_library_titles') on conflict (version) do nothing;
commit;
