-- 手工清理：之前误执行的“纯增量”内容迁移（0031_identity_* ～
-- 0036_content_visibility_functions）。此文件不在 db/migrations/，不会被
-- 自动 runner 执行。只应在重新应用 0031_content_pipeline_cutover 之前运行。
--
-- 为避免误删真实内容，必须显式设置：
--   psql ... -c "set mathpilot.confirm_partial_cleanup = 'true'" -f this-file
-- （两条命令需在同一个 psql 会话中执行，或把 SET 放进事务前。）

begin;

do $$
declare
  stale text[] := array[
    '0031_identity_user_roles_and_classes',
    '0032_storage_objects',
    '0033_content_entities_normalized',
    '0034_content_candidate_review',
    '0035_content_packages_class_release',
    '0036_content_visibility_functions'
  ];
  target text;
  rows_found bigint;
begin
  if current_setting('mathpilot.confirm_partial_cleanup', true) <> 'true' then
    raise exception 'refusing partial-migration cleanup; set mathpilot.confirm_partial_cleanup=true in this session';
  end if;
  if exists (select 1 from infra_schema_migration where version = '0031_content_pipeline_cutover') then
    raise exception 'consolidated 0031_content_pipeline_cutover is already applied; use a planned legacy cutover instead';
  end if;
  if not exists (select 1 from infra_schema_migration where version = any(stale)) then
    raise notice 'no stale incremental migration markers found; nothing to clean';
    return;
  end if;

  -- The partial files used the same target names as the consolidated schema.
  -- They are safe to recreate only when every target table is empty. If any
  -- row exists, stop and restore/recreate the migration database rather than
  -- guessing which definition a prior run intended.
  foreach target in array array[
    'content_package_class_release', 'content_package_item', 'content_package',
    'content_er_start_command', 'content_review_decision', 'content_review_annotation',
    'content_candidate_set_item', 'content_candidate_set',
    'content_diagnosis_rule_citation', 'content_diagnosis_rule_error_cause',
    'content_diagnosis_rule_dimension', 'content_error_cause_knowledge',
    'content_field_provenance', 'content_question_asset_revision',
    'content_source_excerpt', 'content_source_page', 'content_source',
    'content_question_measurement_target', 'content_question_rubric_item',
    'content_question_answer_item', 'content_question_option',
    'content_question_type_knowledge', 'content_knowledge_prerequisite',
    'content_revision_item', 'content_diagnosis_rule_revision',
    'content_error_cause_revision', 'content_question_revision',
    'content_question_type_revision', 'content_knowledge_revision',
    'content_entity_revision', 'content_entity',
    'storage_object', 'identity_class_user', 'identity_user_role'
  ] loop
    if to_regclass('public.' || target) is not null then
      execute format('select count(*) from public.%I', target) into rows_found;
      if rows_found > 0 then
        raise exception 'partial target table %.% contains % rows; restore a clean database instead of deleting data', 'public', target, rows_found;
      end if;
    end if;
  end loop;

  -- Drop only the objects owned by the six abandoned files. CASCADE removes
  -- their temporary foreign-key/policy dependencies but does not drop legacy
  -- content tables; those are handled by the separately guarded 0037 script.
  foreach target in array array[
    'content_package_class_release', 'content_package_item', 'content_package',
    'content_er_start_command', 'content_review_decision', 'content_review_annotation',
    'content_candidate_set_item', 'content_candidate_set',
    'content_diagnosis_rule_citation', 'content_diagnosis_rule_error_cause',
    'content_diagnosis_rule_dimension', 'content_error_cause_knowledge',
    'content_field_provenance', 'content_question_asset_revision',
    'content_source_excerpt', 'content_source_page', 'content_source',
    'content_question_measurement_target', 'content_question_rubric_item',
    'content_question_answer_item', 'content_question_option',
    'content_question_type_knowledge', 'content_knowledge_prerequisite',
    'content_revision_item', 'content_diagnosis_rule_revision',
    'content_error_cause_revision', 'content_question_revision',
    'content_question_type_revision', 'content_knowledge_revision',
    'content_entity_revision', 'content_entity',
    'storage_object', 'identity_class_user', 'identity_user_role'
  ] loop
    execute format('drop table if exists public.%I cascade', target);
  end loop;

  drop function if exists mathpilot_candidate_set_guard();
  drop function if exists mathpilot_revision_guard();
  drop function if exists mathpilot_review_decision_guard();
  drop function if exists mathpilot_review_annotation_guard();
  drop function if exists mathpilot_package_guard();
  drop function if exists mathpilot_content_entity_visible(text,text,text[],text,text,boolean);
  drop function if exists mathpilot_content_package_visible(text,text,text[],text,boolean);
  drop function if exists mathpilot_content_candidate_visible(text,text,text[],text);
  drop function if exists mathpilot_content_can_publish_package(text,text,text[],text,text);
  drop function if exists mathpilot_pending_er_start_commands();
  drop function if exists mathpilot_pending_er_start_commands_v2();
  drop function if exists mathpilot_pending_review_feedback_commands();

  delete from infra_schema_migration where version = any(stale);
end
$$;

commit;
