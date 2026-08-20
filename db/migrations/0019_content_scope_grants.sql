-- 0019: 允许同一结构化实体同时拥有公共授权或多个教师授权。
-- 0018 的首版复合主键还会隐式禁止公共源文件授权中的空 owner。
begin;

alter table content_entity_scope drop constraint if exists content_entity_scope_pkey;
drop index if exists content_entity_scope_grant_unique;
create unique index content_entity_scope_grant_unique
  on content_entity_scope
  (tenant_id,entity_type,entity_id,visibility,owner_teacher_id) nulls not distinct;

alter table content_source_document_grant
  drop constraint if exists content_source_document_grant_pkey;
alter table content_source_document_grant
  alter column owner_teacher_id drop not null;
drop index if exists content_source_document_public_grant;
drop index if exists content_source_document_grant_unique;
create unique index content_source_document_grant_unique
  on content_source_document_grant
  (tenant_id,document_id,visibility,owner_teacher_id) nulls not distinct;

insert into infra_schema_migration(version) values ('0019_content_scope_grants');
commit;
