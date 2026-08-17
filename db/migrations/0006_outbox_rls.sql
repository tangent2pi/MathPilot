-- 0006: 事务性 outbox、RLS 全量启用、不可变事件保护
begin;

create table infra_outbox (
  event_id       text primary key,
  tenant_id      text not null,
  aggregate_type text not null,
  aggregate_id   text not null,
  event_type     text not null,
  payload        jsonb not null,
  correlation_id text,
  causation_id   text,
  occurred_at    timestamptz not null default now(),
  published_at   timestamptz
);
create index infra_outbox_unpublished_idx on infra_outbox(occurred_at) where published_at is null;

-- ── RLS：所有租户表启用行级隔离（应用连接须 set app.current_tenant） ──
do $$
declare
  t text;
begin
  foreach t in array array[
    'identity_user', 'identity_class', 'identity_class_member',
    'content_source_document', 'content_source_fragment',
    'content_knowledge_component', 'content_question_type', 'content_error_cause',
    'content_diagnosis_rule', 'content_question', 'content_question_asset',
    'content_measurement_target', 'content_chapter_package', 'content_field_lineage',
    'runtime_assessment_run', 'runtime_question_session', 'runtime_attempt',
    'runtime_chat_turn', 'runtime_stroke_event_index', 'runtime_draft_segment',
    'runtime_answer_verdict', 'runtime_diagnostic_claim', 'runtime_state_observation',
    'runtime_intervention_event', 'runtime_learning_artifact', 'runtime_artifact_version',
    'runtime_artifact_interaction', 'runtime_teaching_session_summary',
    'runtime_session_learning_record',
    'state_scientific_evaluation_report', 'state_profile_evidence_bundle',
    'state_profile_update_decision', 'state_profile_decision_validation',
    'state_mastery_state', 'state_retention_state', 'state_misconception_state',
    'state_student_snapshot', 'state_review_schedule', 'state_learning_plan',
    'review_review_task', 'review_teacher_correction', 'review_release_record',
    'review_evaluation_run', 'review_agent_trace',
    'infra_outbox'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.current_tenant'', true))'
      ' with check (tenant_id = current_setting(''app.current_tenant'', true))',
      t
    );
  end loop;
end $$;

-- ── 不可变事件保护：事实层禁止 UPDATE/DELETE（设计 §1.3；纠正只能 supersede + 重放） ──
create or replace function forbid_mutation() returns trigger as $$
begin
  raise exception 'immutable table %: corrections must go through supersede + replay', TG_TABLE_NAME;
end
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array[
    'runtime_attempt', 'runtime_chat_turn', 'runtime_stroke_event_index',
    'runtime_draft_segment', 'runtime_answer_verdict', 'runtime_state_observation',
    'runtime_intervention_event', 'runtime_artifact_version', 'runtime_artifact_interaction',
    'runtime_teaching_session_summary', 'runtime_session_learning_record',
    'state_scientific_evaluation_report', 'state_profile_evidence_bundle',
    'state_profile_update_decision', 'state_profile_decision_validation',
    'state_student_snapshot',
    'review_teacher_correction', 'review_agent_trace',
    'infra_outbox'
  ] loop
    execute format(
      'create trigger forbid_mutation before update or delete on %I for each row execute function forbid_mutation()',
      t
    );
  end loop;
end $$;

insert into infra_schema_migration(version) values ('0006_outbox_rls');
commit;
