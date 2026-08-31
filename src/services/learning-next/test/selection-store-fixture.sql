\set ON_ERROR_STOP on
begin;

insert into identity_tenant(tenant_id,name)
values('tnt_selecttest1','Selector test tenant');
insert into identity_user(user_id,tenant_id,oidc_sub,roles)
values('usr_selectstudent1','tnt_selecttest1','sub-select-student-1','{student}');
insert into identity_user_role(tenant_id,user_id,role)
values('tnt_selecttest1','usr_selectstudent1','student');
insert into science_v3_student(student_id,tenant_id,user_id)
values('stu_selecttest1','tnt_selecttest1','usr_selectstudent1');
insert into science_v3_conversation_thread(conversation_thread_id,tenant_id,student_id)
values
  ('thr_selecttest1','tnt_selecttest1','stu_selecttest1'),
  ('thr_selectstale1','tnt_selecttest1','stu_selecttest1');

insert into content_entity(entity_id,tenant_id,entity_kind,origin,created_by_user_id)
values
  ('K_SELECT_TEST','tnt_selecttest1','knowledge','official','usr_selectstudent1'),
  ('Q_SELECT_TEST','tnt_selecttest1','question','official','usr_selectstudent1');
insert into content_entity_revision(revision_id,entity_id,tenant_id,revision_no,lifecycle_status)
values
  ('krev_selecttest1','K_SELECT_TEST','tnt_selecttest1',1,'ready'),
  ('qrev_selecttest1','Q_SELECT_TEST','tnt_selecttest1',1,'ready');
insert into content_knowledge_revision(revision_id,tenant_id,name,description)
values('krev_selecttest1','tnt_selecttest1','面积关系','Selector fixture dimension');
insert into content_question_revision(
  revision_id,tenant_id,chapter_id,stem_format,stem_markdown,difficulty,analysis_markdown
) values(
  'qrev_selecttest1','tnt_selecttest1','chapter-select','single_choice',
  '正方形边长为 2，它的面积是多少？',0.35,'答案为 4；该解析不得出现在目录或 QuestionCard。'
);
insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position)
values
  ('option_selecttest1','qrev_selecttest1','tnt_selecttest1','question_option',0),
  ('answer_selecttest1','qrev_selecttest1','tnt_selecttest1','question_answer',0),
  ('rubric_selecttest1','qrev_selecttest1','tnt_selecttest1','question_rubric',0),
  ('measure_selecttest1','qrev_selecttest1','tnt_selecttest1','question_measurement_target',0);
insert into content_question_option(item_id,tenant_id,option_key,option_text,is_correct)
values('option_selecttest1','tnt_selecttest1','A','4',true);
insert into content_question_answer_item(item_id,tenant_id,answer_text)
values('answer_selecttest1','tnt_selecttest1','4');
insert into content_question_rubric_item(item_id,tenant_id,criterion,score)
values('rubric_selecttest1','tnt_selecttest1','答案等于 4',1);
insert into content_question_measurement_target(
  item_id,tenant_id,dimension_revision_id,target_role,evidence_rule
) values('measure_selecttest1','tnt_selecttest1','krev_selecttest1','primary','rubric_selecttest1');

insert into science_v3_operation(
  operation_id,tenant_id,requested_by_user_id,kind,status,user_message
) values
  ('op_selecttest01','tnt_selecttest1','usr_selectstudent1','select_question','running','正在选题'),
  ('op_selectstale1','tnt_selecttest1','usr_selectstudent1','select_question','running','正在选题');
insert into science_v3_selection_intent(
  selection_intent_id,tenant_id,conversation_thread_id,student_id,revision,source,
  natural_language_request,activity_constraints,context_snapshot_ref,supersedes_intent_id,created_at
) values
  ('int_selecttest1','tnt_selecttest1','thr_selecttest1','stu_selecttest1',1,'student',
   '找一道正式测量面积的选择题。','{"measurement_eligibility":"formal"}'::jsonb,
   'agent-artifact:art_selectinput1',null,'2026-08-31T08:00:00Z'),
  ('int_selectstale1','tnt_selecttest1','thr_selectstale1','stu_selecttest1',1,'student',
   '旧要求。','{}'::jsonb,'agent-artifact:art_selectstale1',null,'2026-08-31T08:00:00Z'),
  ('int_selectnewer1','tnt_selecttest1','thr_selectstale1','stu_selecttest1',2,'student',
   '新要求。','{}'::jsonb,'snapshot:selector/select-newer/v2','int_selectstale1','2026-08-31T08:01:00Z');
insert into science_v3_agent_artifact(
  artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
) values
  ('art_selectinput1','tnt_selecttest1','op_selecttest01','input_bundle',
   'https://schemas.mathpilot.dev/science-v3/selector-input/v1','{}'::jsonb,repeat('0',64)),
  ('art_selectstale1','tnt_selecttest1','op_selectstale1','input_bundle',
   'https://schemas.mathpilot.dev/science-v3/selector-input/v1','{}'::jsonb,repeat('1',64)),
  ('art_selectstaleout1','tnt_selecttest1','op_selectstale1','structured_output',
   'https://schemas.mathpilot.dev/science-v3/selection-decision/v1',
   '{
      "schema_version":3,"decision_type":"selected",
      "intent_id":"int_selectstale1","intent_revision":1,
      "chosen_question_revision_id":"qrev_selecttest1",
      "satisfied_requirements":["旧要求"],"unsatisfied_preferences":[],
      "scientific_purpose":"practice","target_dimensions":[],"target_error_causes":[],
      "evidence_refs":["catalog-page://cpg_stale0001"],
      "decision_summary":"该结果已经过时。"
    }'::jsonb,repeat('2',64));
insert into infra_outbox(
  event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
  causation_id,occurred_at,aggregate_version,payload_ref,operation_id
) values
  ('evt_selecttest01','tnt_selecttest1','conversation-thread','thr_selecttest1',
   'selection.intent_revised','{}'::jsonb,'op_selecttest01','idem.selecttest01',
   '2026-08-31T08:00:00Z',1,'agent-artifact:art_selectinput1','op_selecttest01'),
  ('evt_selectstale1','tnt_selecttest1','conversation-thread','thr_selectstale1',
   'selection.intent_revised','{}'::jsonb,'op_selectstale1','idem.selectstale1',
   '2026-08-31T08:00:00Z',1,'agent-artifact:art_selectstale1','op_selectstale1');
insert into science_v3_selection_request(
  tenant_id,operation_id,idempotency_key,command_sha256,event_id,selection_intent_id,
  intent_revision,input_artifact_id,requested_at
) values
  ('tnt_selecttest1','op_selecttest01','idem.selecttest01',repeat('a',64),
   'evt_selecttest01','int_selecttest1',1,'art_selectinput1','2026-08-31T08:00:00Z'),
  ('tnt_selecttest1','op_selectstale1','idem.selectstale1',repeat('b',64),
   'evt_selectstale1','int_selectstale1',1,'art_selectstale1','2026-08-31T08:00:00Z');
insert into science_v3_agent_attempt(
  agent_attempt_id,tenant_id,operation_id,workflow_id,workflow_run_id,temporal_activity_id,
  task_type,task_spec_version,temporal_attempt,status,input_ref,output_ref,model_policy_id,
  resolved_model_id,prompt_version,skill_ref,input_tokens,output_tokens,completed_at
) values
  ('agt_selecttest01','tnt_selecttest1','op_selecttest01',
   'select-question:tnt_selecttest1:thr_selecttest1','run-select-1','selector-r1-n1',
   'select_question','v1',1,'started','agent-artifact:art_selectinput1',null,
   'select_question-model-v1',null,'select_question-prompt@v1','skill:question-selection@v1',null,null,null),
  ('agt_selectstale1','tnt_selecttest1','op_selectstale1',
   'select-question:tnt_selecttest1:thr_selectstale1','run-stale-1','selector-r1-n1',
   'select_question','v1',1,'succeeded','agent-artifact:art_selectstale1',
   'agent-artifact:art_selectstaleout1','select_question-model-v1',
   'deepseek-v4-flash-vision-exp','select_question-prompt@v1','skill:question-selection@v1',10,5,
   '2026-08-31T08:00:10Z');

commit;
