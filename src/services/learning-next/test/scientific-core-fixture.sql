\set ON_ERROR_STOP on
begin;

insert into identity_user(user_id,tenant_id,oidc_sub,roles) values
  ('usr_flowteacher01','tnt_flowtest01','sub-flow-teacher-01','{teacher}');
insert into identity_user_role(tenant_id,user_id,role) values
  ('tnt_flowtest01','usr_flowteacher01','teacher');

insert into content_entity(entity_id,tenant_id,entity_kind,origin) values
  ('E_FLOW_A','tnt_flowtest01','error_cause','official'),
  ('E_FLOW_B','tnt_flowtest01','error_cause','official'),
  ('R_FLOW_AB','tnt_flowtest01','diagnosis_rule','official');
insert into content_entity_revision(
  revision_id,entity_id,tenant_id,revision_no,lifecycle_status
) values
  ('erev_flow_a','E_FLOW_A','tnt_flowtest01',1,'ready'),
  ('erev_flow_b','E_FLOW_B','tnt_flowtest01',1,'ready'),
  ('rrev_flow_ab','R_FLOW_AB','tnt_flowtest01',1,'ready');
insert into content_error_cause_revision(
  revision_id,tenant_id,category,name,description,manifestation,judgment_basis,remediation
) values
  ('erev_flow_a','tnt_flowtest01','fixture','Flow cause A','Fixture A','A','A','A'),
  ('erev_flow_b','tnt_flowtest01','fixture','Flow cause B','Fixture B','B','B','B');
insert into content_diagnosis_rule_revision(
  revision_id,tenant_id,rule_version,trigger_text,probe_text
) values ('rrev_flow_ab','tnt_flowtest01','1','Differentiate A and B.','Give the bounded probe.');
insert into science_v3_error_cause_policy(
  tenant_id,error_cause_revision_id,accepted_verification_sets,
  confirmed_near_due_days,improving_followup_due_days,resolved_delayed_due_days,
  policy_version,published_at
) values
  ('tnt_flowtest01','erev_flow_a','[["near_transfer","far_transfer"],["near_transfer","delayed_verification"]]'::jsonb,1,7,30,1,'2026-01-01T00:00:00Z'),
  ('tnt_flowtest01','erev_flow_b','[["near_transfer","far_transfer"],["near_transfer","delayed_verification"]]'::jsonb,1,7,30,1,'2026-01-01T00:00:00Z');
insert into science_v3_diagnosis_outcome_bin(
  tenant_id,rule_revision_id,outcome_bin_id,label,quality,terminal_status,classification_criterion
) values
  ('tnt_flowtest01','rrev_flow_ab','supports_b','Supports B','strong','concluded','The probe counters A and supports B.'),
  ('tnt_flowtest01','rrev_flow_ab','counters_b','Counters B','strong','concluded','The near-transfer response counters B.');
insert into science_v3_diagnosis_outcome_relation(
  tenant_id,rule_revision_id,outcome_bin_id,error_cause_revision_id,relation
) values
  ('tnt_flowtest01','rrev_flow_ab','supports_b','erev_flow_a','counters'),
  ('tnt_flowtest01','rrev_flow_ab','supports_b','erev_flow_b','supports'),
  ('tnt_flowtest01','rrev_flow_ab','counters_b','erev_flow_a','non_discriminating'),
  ('tnt_flowtest01','rrev_flow_ab','counters_b','erev_flow_b','counters');
insert into science_v3_question_error_role(
  tenant_id,question_revision_id,error_cause_revision_id,role
) values ('tnt_flowtest01','qrev_flowtest_v1','erev_flow_b','verifies_near');

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
      "diagnosis_rule_revision_ids":["rrev_flow_ab"],
      "evidence_policy_version":"evidence-policy-production-v1@1"
    }'::jsonb,'closed',1,'2026-01-01T00:00:00Z','2026-01-01T00:02:00Z','completed',2),
  ('qsn_science002','tnt_flowtest01','thr_flowtest01','stu_flowtest01','int_flowtest01',1,
   'qrev_flowtest_v1','catalog','{
      "contract_version":1,"measurement_eligibility":"formal",
      "rubric_revision_id":"rubric-flowtest-v1",
      "dimension_revision_ids":["krev_flowtest_v1"],
      "diagnosis_rule_revision_ids":["rrev_flow_ab"],
      "evidence_policy_version":"evidence-policy-production-v1@1"
    }'::jsonb,'closed',1,'2026-01-03T00:00:00Z','2026-01-03T00:02:00Z','completed',2),
  ('qsn_science003','tnt_flowtest01','thr_flowtest01','stu_flowtest01','int_flowtest01',1,
   'qrev_flowtest_v1','catalog','{
      "contract_version":1,"measurement_eligibility":"formal",
      "rubric_revision_id":"rubric-flowtest-v1",
      "dimension_revision_ids":["krev_flowtest_v1"],
      "diagnosis_rule_revision_ids":["rrev_flow_ab"],
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

insert into science_v3_diagnostic_claim(
  diagnostic_claim_id,tenant_id,student_id,question_session_id,trigger_evidence_refs,
  active_rule_revision_id,status,conclusion_refs,created_at,closed_at,version
) values
  ('dcl_science001','tnt_flowtest01','stu_flowtest01','qsn_science001',array['answer://msg_science001/part-1'],
   'rrev_flow_ab','concluded',array['judgment://jdg_science001'],'2026-01-01T00:01:10Z','2026-01-01T00:01:40Z',1),
  ('dcl_science002','tnt_flowtest01','stu_flowtest01','qsn_science002',array['answer://msg_science002/part-1'],
   'rrev_flow_ab','concluded',array['judgment://jdg_science002'],'2026-01-03T00:01:10Z','2026-01-03T00:01:40Z',1),
  ('dcl_science003','tnt_flowtest01','stu_flowtest01','qsn_science003',array['answer://msg_science003/part-1'],
   'rrev_flow_ab','concluded',array['judgment://jdg_science003'],'2026-01-06T00:01:10Z','2026-01-06T00:01:40Z',1);
insert into science_v3_diagnostic_claim_candidate(
  tenant_id,diagnostic_claim_id,position,error_cause_revision_id,prior_rationale
) values
  ('tnt_flowtest01','dcl_science001',0,'erev_flow_a','Candidate A.'),
  ('tnt_flowtest01','dcl_science001',1,'erev_flow_b','Candidate B.'),
  ('tnt_flowtest01','dcl_science002',0,'erev_flow_a','Candidate A.'),
  ('tnt_flowtest01','dcl_science002',1,'erev_flow_b','Candidate B.'),
  ('tnt_flowtest01','dcl_science003',0,'erev_flow_a','Candidate A.'),
  ('tnt_flowtest01','dcl_science003',1,'erev_flow_b','Candidate B.');
insert into science_v3_diagnosis_outcome(
  diagnostic_outcome_id,tenant_id,diagnostic_claim_id,rule_revision_id,
  outcome_bin_id,judgment_id,evidence_refs,created_at,fact_version
) values
  ('dot_science001','tnt_flowtest01','dcl_science001','rrev_flow_ab','supports_b','jdg_science001',
   array['answer://msg_science001/part-1'],'2026-01-01T00:01:35Z',1),
  ('dot_science002','tnt_flowtest01','dcl_science002','rrev_flow_ab','supports_b','jdg_science002',
   array['answer://msg_science002/part-1'],'2026-01-03T00:01:35Z',1),
  ('dot_science003','tnt_flowtest01','dcl_science003','rrev_flow_ab','counters_b','jdg_science003',
   array['answer://msg_science003/part-1'],'2026-01-06T00:01:35Z',1);

commit;
