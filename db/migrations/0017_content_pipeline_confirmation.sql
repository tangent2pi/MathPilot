-- 0017: 资料上传与内容处理分离。上传先进入 draft，用户确认后才启动 KTQ/ER。
begin;

alter table content_pipeline_run drop constraint if exists content_pipeline_run_status_check;
alter table content_pipeline_run add constraint content_pipeline_run_status_check
  check (status in ('draft','queued','running','review_ready','failed'));

insert into infra_schema_migration(version) values ('0017_content_pipeline_confirmation');
commit;
