-- 0024: 发布内容包后将对应资料任务推进到可恢复的完成状态。
begin;

alter table content_pipeline_run drop constraint if exists content_pipeline_run_status_check;
alter table content_pipeline_run add constraint content_pipeline_run_status_check
  check (status in ('draft','queued','running','review_ready','published','failed'));

insert into infra_schema_migration(version) values ('0024_content_pipeline_published');
commit;
