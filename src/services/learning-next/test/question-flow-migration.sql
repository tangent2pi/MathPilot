\set ON_ERROR_STOP on
begin;

insert into identity_tenant(tenant_id,name) values
  ('tnt_flowtest01','Flow test tenant'),
  ('tnt_flowtest02','Other tenant');
insert into identity_user(user_id,tenant_id,oidc_sub,roles) values
  ('usr_flowstudent01','tnt_flowtest01','sub-flow-student-01','{student}'),
  ('usr_flowstudent02','tnt_flowtest02','sub-flow-student-02','{student}');
insert into identity_user_role(tenant_id,user_id,role) values
  ('tnt_flowtest01','usr_flowstudent01','student'),
  ('tnt_flowtest02','usr_flowstudent02','student');
insert into science_v3_student(student_id,tenant_id,user_id) values
  ('stu_flowtest01','tnt_flowtest01','usr_flowstudent01'),
  ('stu_flowtest02','tnt_flowtest02','usr_flowstudent02');

insert into content_entity(entity_id,tenant_id,entity_kind,origin,created_by_user_id) values
  ('question-flow-test','tnt_flowtest01','question','official','usr_flowstudent01'),
  ('knowledge-flow-test','tnt_flowtest01','knowledge','official','usr_flowstudent01');
insert into content_entity_revision(revision_id,entity_id,tenant_id,revision_no,lifecycle_status) values
  ('qrev_flowtest_v1','question-flow-test','tnt_flowtest01',1,'ready'),
  ('krev_flowtest_v1','knowledge-flow-test','tnt_flowtest01',1,'ready');
insert into content_question_revision(
  revision_id,tenant_id,chapter_id,stem_format,stem_markdown,difficulty,analysis_markdown
) values (
  'qrev_flowtest_v1','tnt_flowtest01','chapter-flow-test','open_solution',
  'Compute the test value.',0.5,'The test value is one.'
);
insert into content_knowledge_revision(revision_id,tenant_id,name,description) values
  ('krev_flowtest_v1','tnt_flowtest01','Flow dimension','Test dimension');
insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values
  ('answer_flowtest01','qrev_flowtest_v1','tnt_flowtest01','question_answer',0),
  ('rubric_flowtest01','qrev_flowtest_v1','tnt_flowtest01','question_rubric',0),
  ('measure_flowtest01','qrev_flowtest_v1','tnt_flowtest01','question_measurement_target',0);
insert into content_question_answer_item(item_id,tenant_id,answer_text) values
  ('answer_flowtest01','tnt_flowtest01','1');
insert into content_question_rubric_item(item_id,tenant_id,criterion,score) values
  ('rubric_flowtest01','tnt_flowtest01','The response equals one.',1);
insert into content_question_measurement_target(
  item_id,tenant_id,dimension_revision_id,target_role,evidence_rule
) values (
  'measure_flowtest01','tnt_flowtest01','krev_flowtest_v1','primary','rubric_flowtest01'
);

insert into science_v3_conversation_thread(
  conversation_thread_id,tenant_id,student_id
) values
  ('thr_flowtest01','tnt_flowtest01','stu_flowtest01'),
  ('thr_flowtest02','tnt_flowtest02','stu_flowtest02');

select * from mathpilot_science_v3_record_selection_intent(
  'tnt_flowtest01','int_flowtest01','thr_flowtest01','stu_flowtest01',1,'student',
  'Give me one bounded test question.','{}'::jsonb,'snapshot:selector/flowtest/v1',null,
  '2026-08-31T08:00:00Z'
);
select * from mathpilot_science_v3_open_question_session(
  'tnt_flowtest01','qsn_flowtest01','thr_flowtest01','stu_flowtest01',null,
  'int_flowtest01',1,'qrev_flowtest_v1',null,'catalog',
  '{
    "contract_version":1,
    "measurement_eligibility":"formal",
    "rubric_revision_id":"rubric-flowtest-v1",
    "dimension_revision_ids":["krev_flowtest_v1"],
    "diagnosis_rule_revision_ids":[],
    "evidence_policy_version":"evidence-policy-v1",
    "frozen_at":"2026-08-31T08:00:00Z"
  }'::jsonb,
  null,'fge_flowtest01','snapshot:foreground/flowtest/v1',1,
  '2026-08-31T08:00:00Z'
);

select * from mathpilot_science_v3_submit_attempt(
  'tnt_flowtest01','usr_flowstudent01','op_flowattempt01','idem.flowattempt01',
  'att_flowtest01','msg_flowtest01','thr_flowtest01','qsn_flowtest01',1,
  'qrev_flowtest_v1','answer','[{"type":"text","text":"1"}]'::jsonb,
  array['answer://msg_flowtest01/part-1'],0,'2026-08-31T08:01:00Z'
);

do $$
begin
  if (select version from science_v3_question_session where question_session_id='qsn_flowtest01') <> 2 then
    raise exception 'Attempt admission did not advance QuestionSession version';
  end if;
  if (select count(*) from science_v3_attempt where question_session_id='qsn_flowtest01') <> 1
     or (select count(*) from science_v3_canonical_message where question_session_id='qsn_flowtest01') <> 1 then
    raise exception 'Attempt and canonical message were not atomically admitted';
  end if;
end
$$;

-- A lost response retries through the same idempotency key without a second
-- Attempt or message, even when the client regenerated candidate IDs.
select * from mathpilot_science_v3_submit_attempt(
  'tnt_flowtest01','usr_flowstudent01','op_flowattempt02','idem.flowattempt01',
  'att_flowtest02','msg_flowtest02','thr_flowtest01','qsn_flowtest01',2,
  'qrev_flowtest_v1','answer','[{"type":"text","text":"duplicate"}]'::jsonb,
  array['answer://msg_flowtest02/part-1'],0,'2026-08-31T08:01:01Z'
);

select * from mathpilot_science_v3_request_cut(
  'tnt_flowtest01','usr_flowstudent01','op_flowcut0001','idem.flowcut0001',
  'cut_flowtest01','evt_flowcut0001','art_flowcut0001','thr_flowtest01','qsn_flowtest01',2,
  'student_switch','intent:int_flowtest02/r2',
  '{"schema_version":3,"cut_request_ref":"cut-request:cut_flowtest01","question_session_ref":"question-session:qsn_flowtest01"}'::jsonb,
  '0000000000000000000000000000000000000000000000000000000000000000',
  '2026-08-31T08:02:00Z'
);

-- A concurrent second button press converges on the first Cut and operation.
create temporary table flow_duplicate_cut_result as
select * from mathpilot_science_v3_request_cut(
  'tnt_flowtest01','usr_flowstudent01','op_flowcut0002','idem.flowcut0002',
  'cut_flowtest02','evt_flowcut0002','art_flowcut0002','thr_flowtest01','qsn_flowtest01',2,
  'completed',null,
  '{"schema_version":3,"cut_request_ref":"cut-request:cut_flowtest02","question_session_ref":"question-session:qsn_flowtest01"}'::jsonb,
  '1111111111111111111111111111111111111111111111111111111111111111',
  '2026-08-31T08:02:01Z'
);

do $$
begin
  if (select lifecycle from science_v3_question_session where question_session_id='qsn_flowtest01') <> 'finalizing'
     or (select frozen_attempt_sequence from science_v3_question_session where question_session_id='qsn_flowtest01') <> 1 then
    raise exception 'Cut did not freeze the admitted Attempt window';
  end if;
  if (select count(*) from science_v3_cut_request where question_session_id='qsn_flowtest01') <> 1
     or (select command_operation_id from flow_duplicate_cut_result) <> 'op_flowcut0001'
     or (select accepted_cut_request_id from flow_duplicate_cut_result) <> 'cut_flowtest01' then
    raise exception 'concurrent Cut did not converge on the first request';
  end if;
  if (select count(*) from infra_outbox where event_type='question.cut_requested' and aggregate_id='qsn_flowtest01') <> 1 then
    raise exception 'Cut outbox event was duplicated';
  end if;
end
$$;

create temporary table flow_late_attempt_result as
select * from mathpilot_science_v3_submit_attempt(
  'tnt_flowtest01','usr_flowstudent01','op_flowattempt03','idem.flowattempt03',
  'att_flowtest03','msg_flowtest03','thr_flowtest01','qsn_flowtest01',3,
  'qrev_flowtest_v1','answer','[{"type":"text","text":"late"}]'::jsonb,
  array['answer://msg_flowtest03/part-1'],0,'2026-08-31T08:03:00Z'
);
do $$
begin
  if (select result_status from flow_late_attempt_result) <> 'rejected'
     or (select rejection_code from flow_late_attempt_result) <> 'closed'
     or (select count(*) from science_v3_attempt where question_session_id='qsn_flowtest01') <> 1 then
    raise exception 'Attempt after Freeze was not rejected';
  end if;
  begin
    update science_v3_attempt set hint_level=1 where attempt_id='att_flowtest01';
    raise exception 'Attempt mutation unexpectedly succeeded';
  exception when raise_exception then
    if SQLERRM = 'Attempt mutation unexpectedly succeeded' then raise; end if;
  end;
  begin
    update science_v3_canonical_message set parts='[{"type":"text","text":"rewritten"}]'::jsonb
     where message_id='msg_flowtest01';
    raise exception 'committed evidence message mutation unexpectedly succeeded';
  exception when raise_exception then
    if SQLERRM = 'committed evidence message mutation unexpectedly succeeded' then raise; end if;
  end;
end
$$;

-- Forced RLS keeps another tenant invisible to the application role.
set local role mathpilot_app;
select set_config('app.current_tenant','tnt_flowtest01',true);
do $$
begin
  if (select count(*) from science_v3_conversation_thread) <> 1 then
    raise exception 'science-v3 Thread RLS leaked another tenant';
  end if;
end
$$;
reset role;

commit;
