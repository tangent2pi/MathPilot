-- 手工正式切换后的旧内容管线清理，不属于自动迁移。
--
-- 运行前必须：
-- 1. 已应用 0031_content_pipeline_cutover；
-- 2. 已执行并审核 official-content importer；
-- 3. 已停止旧 content/learning/review/agent-runtime/api 入口及其 worker；
-- 4. 在同一 psql 会话设置 mathpilot.allow_legacy_content_drop=true。
--
-- Next schema 不依赖任何旧 content payload/source 表。本脚本在切流验收后
-- 完整移除旧内容表与数据库入口；规范化 content_entity/revision/source 表保留。

begin;
do $$
begin
  if current_setting('mathpilot.allow_legacy_content_drop', true) <> 'true' then
    raise exception 'set mathpilot.allow_legacy_content_drop=true before removing the legacy content pipeline';
  end if;
  if not exists (select 1 from infra_schema_migration where version = '0031_content_pipeline_cutover') then
    raise exception '0031_content_pipeline_cutover is not applied';
  end if;
  if 174 <> (
    select count(*) from content_package_item where package_id='pkg_official_home_v1'
  ) then
    raise exception 'official package pkg_official_home_v1 is not reconciled to 174 revisions';
  end if;
end
$$;

-- 旧 worker/投影入口先删，防止切流后继续产生旧状态。
drop table if exists content_pipeline_card_dismissal cascade;
drop table if exists content_pipeline_run cascade;
drop table if exists content_source_document_grant cascade;
drop table if exists content_entity_scope cascade;
drop table if exists identity_teacher_student_binding cascade;
drop table if exists content_knowledge_asset_link cascade;
drop table if exists content_measurement_target cascade;
drop table if exists content_chapter_package cascade;

-- 旧核心 payload/source 表没有被 0031 扩列或读取；官方内容已经由 CSV
-- manifest 导入独立的规范化修订，因此这里可以在受保护窗口整体移除。
drop table if exists content_field_lineage cascade;
drop table if exists content_question_asset cascade;
drop table if exists content_source_fragment cascade;
drop table if exists content_source_document cascade;
drop table if exists content_question cascade;
drop table if exists content_diagnosis_rule cascade;
drop table if exists content_error_cause cascade;
drop table if exists content_question_type cascade;
drop table if exists content_knowledge_component cascade;

drop function if exists mathpilot_agent_library(text,text,integer,integer);
drop function if exists mathpilot_agent_question(text);
drop function if exists mathpilot_pending_content_pipelines();

commit;
