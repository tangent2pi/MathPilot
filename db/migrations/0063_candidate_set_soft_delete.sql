-- Candidate sets are archived without deleting their immutable content revisions.
begin;

alter table content_candidate_set add column if not exists deleted_at timestamptz;
create index if not exists content_candidate_set_deleted_at_idx
  on content_candidate_set (tenant_id, owner_teacher_user_id, deleted_at, created_at desc);

insert into infra_schema_migration(version) values ('0063_candidate_set_soft_delete');
commit;
