\set ON_ERROR_STOP on
begin;

insert into identity_user(user_id,tenant_id,oidc_sub,roles) values
  ('usr_flowteacher01','tnt_flowtest01','sub-flow-teacher-01','{teacher}');
insert into identity_user_role(tenant_id,user_id,role) values
  ('tnt_flowtest01','usr_flowteacher01','teacher');

insert into science_v3_dimension_lineage(
  tenant_id,dimension_revision_id,dimension_id,lineage_version,approved_at
) values (
  'tnt_flowtest01','krev_flowtest_v1','K_FLOW_TEST',1,'2026-01-01T00:00:00Z'
);
insert into science_v3_retention_unit_revision(
  retention_unit_revision_id,tenant_id,dimension_revision_id,scope_facets,definition_version,created_at
) values (
  'rurev_flowtest_v1','tnt_flowtest01','krev_flowtest_v1',
  '{"method":"direct"}'::jsonb,1,'2026-01-01T00:00:00Z'
);
insert into science_v3_retention_unit_measurement_rule(
  tenant_id,question_revision_id,measurement_rule_id,retention_unit_revision_id,created_at
) values (
  'tnt_flowtest01','qrev_flowtest_v1','measure_flowtest01','rurev_flowtest_v1','2026-01-01T00:00:00Z'
);

insert into science_v3_question_session(
  question_session_id,tenant_id,conversation_thread_id,student_id,selection_intent_id,
  selection_intent_revision,question_revision_id,source,frozen_measurement_contract,
  lifecycle,frozen_attempt_sequence,opened_at,closed_at,close_reason,version
) values
  ('qsn_science001','tnt_flowtest01','thr_flowtest01','stu_flowtest01','int_flowtest01',1,
   'qrev_flowtest_v1','catalog','{
      "contract_version":1,"measurement_eligibility":"formal",
      "rubric_revision_id":"rubric-flowtest-v1",
      "dimension_revision_ids":["krev_flowtest_v1"],
      "diagnosis_rule_revision_ids":[],
      "evidence_policy_version":"evidence-policy-production-v1@1"
    }'::jsonb,'closed',1,'2026-01-01T00:00:00Z','2026-01-01T00:02:00Z','completed',2),
  ('qsn_science002','tnt_flowtest01','thr_flowtest01','stu_flowtest01','int_flowtest01',1,
   'qrev_flowtest_v1','catalog','{
      "contract_version":1,"measurement_eligibility":"formal",
      "rubric_revision_id":"rubric-flowtest-v1",
      "dimension_revision_ids":["krev_flowtest_v1"],
      "diagnosis_rule_revision_ids":[],
      "evidence_policy_version":"evidence-policy-production-v1@1"
    }'::jsonb,'closed',1,'2026-01-03T00:00:00Z','2026-01-03T00:02:00Z','completed',2),
  ('qsn_science003','tnt_flowtest01','thr_flowtest01','stu_flowtest01','int_flowtest01',1,
   'qrev_flowtest_v1','catalog','{
      "contract_version":1,"measurement_eligibility":"formal",
      "rubric_revision_id":"rubric-flowtest-v1",
      "dimension_revision_ids":["krev_flowtest_v1"],
      "diagnosis_rule_revision_ids":[],
      "evidence_policy_version":"evidence-policy-production-v1@1"
    }'::jsonb,'closed',1,'2026-01-06T00:00:00Z','2026-01-06T00:02:00Z','completed',2);

insert into science_v3_canonical_message(
  message_id,tenant_id,conversation_thread_id,sequence,author_kind,author_user_id,
  lifecycle,parts,question_session_id,editable,lock_reason,created_at,version
) values
  ('msg_science001','tnt_flowtest01','thr_flowtest01',2,'student','usr_flowstudent01',
   'committed','[{"type":"text","text":"1"}]'::jsonb,'qsn_science001',false,'attempt_recorded','2026-01-01T00:01:00Z',1),
  ('msg_science002','tnt_flowtest01','thr_flowtest01',3,'student','usr_flowstudent01',
   'committed','[{"type":"text","text":"1"}]'::jsonb,'qsn_science002',false,'attempt_recorded','2026-01-03T00:01:00Z',1),
  ('msg_science003','tnt_flowtest01','thr_flowtest01',4,'student','usr_flowstudent01',
   'committed','[{"type":"text","text":"0"}]'::jsonb,'qsn_science003',false,'attempt_recorded','2026-01-06T00:01:00Z',1);

insert into science_v3_attempt(
  attempt_id,tenant_id,question_session_id,question_revision_id,student_id,kind,
  content_refs,message_id,hint_level,session_sequence,admitted_session_version,
  idempotency_key,submitted_at,fact_version
) values
  ('att_science001','tnt_flowtest01','qsn_science001','qrev_flowtest_v1','stu_flowtest01','answer',
   array['answer://msg_science001/part-1'],'msg_science001',0,1,1,'idem.science001','2026-01-01T00:01:00Z',1),
  ('att_science002','tnt_flowtest01','qsn_science002','qrev_flowtest_v1','stu_flowtest01','answer',
   array['answer://msg_science002/part-1'],'msg_science002',0,1,1,'idem.science002','2026-01-03T00:01:00Z',1),
  ('att_science003','tnt_flowtest01','qsn_science003','qrev_flowtest_v1','stu_flowtest01','answer',
   array['answer://msg_science003/part-1'],'msg_science003',0,1,1,'idem.science003','2026-01-06T00:01:00Z',1);

insert into science_v3_judgment(
  judgment_id,tenant_id,attempt_id,verdict,rubric_results,dimension_proposals,
  uncertainty,decision_summary,evidence_refs,model_id,prompt_version,skill_version,
  created_at,fact_version
) values
  ('jdg_science001','tnt_flowtest01','att_science001','correct',
   '[{"rubric_item_id":"rubric_flowtest01","status":"met","evidence_refs":["answer://msg_science001/part-1"]}]'::jsonb,
   '[{"dimension_revision_id":"krev_flowtest_v1","rubric_item_id":"rubric_flowtest01","outcome":"success"}]'::jsonb,
   'low','Correct first review.',array['answer://msg_science001/part-1'],
   'fixture','fixture-v1','question-grade@v1','2026-01-01T00:01:30Z',1),
  ('jdg_science002','tnt_flowtest01','att_science002','correct',
   '[{"rubric_item_id":"rubric_flowtest01","status":"met","evidence_refs":["answer://msg_science002/part-1"]}]'::jsonb,
   '[{"dimension_revision_id":"krev_flowtest_v1","rubric_item_id":"rubric_flowtest01","outcome":"success"}]'::jsonb,
   'low','Correct delayed review.',array['answer://msg_science002/part-1'],
   'fixture','fixture-v1','question-grade@v1','2026-01-03T00:01:30Z',1),
  ('jdg_science003','tnt_flowtest01','att_science003','incorrect',
   '[{"rubric_item_id":"rubric_flowtest01","status":"not_met","evidence_refs":["answer://msg_science003/part-1"]}]'::jsonb,
   '[{"dimension_revision_id":"krev_flowtest_v1","rubric_item_id":"rubric_flowtest01","outcome":"failure"}]'::jsonb,
   'low','Incorrect delayed review.',array['answer://msg_science003/part-1'],
   'fixture','fixture-v1','question-grade@v1','2026-01-06T00:01:30Z',1);

commit;
