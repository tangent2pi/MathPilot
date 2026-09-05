-- Teacher paper database package: persist the resolved two lower module levels.
begin;

alter table content_question_revision add column if not exists module_2 text;
alter table content_question_revision add column if not exists module_3 text;

create index if not exists content_question_revision_module_idx
  on content_question_revision (tenant_id, chapter_id, module_2, module_3);

insert into infra_schema_migration(version) values ('0061_question_module_path');
commit;
