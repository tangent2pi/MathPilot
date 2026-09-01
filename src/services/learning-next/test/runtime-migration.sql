begin;
set local role mathpilot_app;
select set_config('app.current_tenant', 'tnt_dev00001', true);
select set_config('app.current_user', 'usr_teacher01', true);
select set_config('app.current_roles', 'teacher', true);

insert into science_v3_operation (
  operation_id, tenant_id, requested_by_user_id, kind, status, user_message
) values (
  'op_runtime0001', 'tnt_dev00001', 'usr_teacher01', 'select_question', 'accepted', '测试任务已排队'
);

insert into science_v3_agent_artifact (
  artifact_id, tenant_id, operation_id, artifact_kind, schema_uri, payload, sha256
) values (
  'art_runtimeinput1', 'tnt_dev00001', 'op_runtime0001', 'input_bundle',
  'https://schemas.mathpilot.dev/science-v3/selector-input/v1',
  '{"schema_version":3}'::jsonb,
  'd27d5fd0edbe2397ccd286daf420dc58c3ff4dff1d08a60724d5d88768a5673d'
), (
  'art_runtimeoutput1', 'tnt_dev00001', 'op_runtime0001', 'structured_output',
  'https://schemas.mathpilot.dev/science-v3/selection-decision/v1',
  '{"question_ref":"question:q1"}'::jsonb,
  'c2d747a95ad2323b64a931d2d15dd7ef113b193eac8a5a2b02d313be77f46349'
);

insert into infra_outbox (
  event_id, tenant_id, aggregate_type, aggregate_id, event_type, payload,
  occurred_at, aggregate_version, payload_ref, operation_id
) values (
  'evt_runtime0001', 'tnt_dev00001', 'selection-intent', 'intent_runtime0001',
  'selection.intent_revised', '{}'::jsonb, '2026-08-31T00:00:00Z', 1,
  'agent-artifact:art_runtimeinput1', 'op_runtime0001'
);

do $$
declare pending_count integer;
begin
  select count(*) into pending_count
    from mathpilot_science_v3_pending_workflow_starts(10)
   where event_id = 'evt_runtime0001';
  if pending_count <> 1 then
    raise exception 'expected one pending workflow start, found %', pending_count;
  end if;
end
$$;

select mathpilot_science_v3_mark_workflow_started(
  'evt_runtime0001',
  'selection.intent_revised:evt_runtime0001',
  'mathpilot_learning_next'
);
-- Simulate acknowledgement loss: the same delivery confirmation is safe.
select mathpilot_science_v3_mark_workflow_started(
  'evt_runtime0001',
  'selection.intent_revised:evt_runtime0001',
  'mathpilot_learning_next'
);

update science_v3_operation
   set status = 'running', user_message = '正在处理', updated_at = clock_timestamp(), version = version + 1
 where tenant_id = 'tnt_dev00001' and operation_id = 'op_runtime0001';

-- The same Activity/attempt number in two Continue-As-New runs is two audit attempts.
insert into science_v3_agent_attempt (
  agent_attempt_id, tenant_id, operation_id, workflow_id, workflow_run_id,
  temporal_activity_id, task_type, task_spec_version, temporal_attempt,
  input_ref, model_policy_id, prompt_version, skill_ref
) values (
  'agt_runtimerun001', 'tnt_dev00001', 'op_runtime0001',
  'selection.intent_revised:evt_runtime0001', 'run-1', 'pi-r1-n1',
  'select_question', 'v1', 1, 'agent-artifact:art_runtimeinput1',
  'select-question-model-v1', 'select-question-prompt@v1', 'skill:question-selection@v1'
), (
  'agt_runtimerun002', 'tnt_dev00001', 'op_runtime0001',
  'selection.intent_revised:evt_runtime0001', 'run-2', 'pi-r1-n1',
  'select_question', 'v1', 1, 'agent-artifact:art_runtimeinput1',
  'select-question-model-v1', 'select-question-prompt@v1', 'skill:question-selection@v1'
);

update science_v3_agent_attempt
   set status = 'succeeded', output_ref = 'agent-artifact:art_runtimeoutput1',
       resolved_model_id = 'deepseek-v4-flash-vision-exp', input_tokens = 10,
       output_tokens = 5, completed_at = clock_timestamp()
 where tenant_id = 'tnt_dev00001' and operation_id = 'op_runtime0001';

insert into science_v3_operation_result (
  tenant_id, operation_id, idempotency_key, result_status, aggregate_ref,
  aggregate_version, result_resource_refs
) values (
  'tnt_dev00001', 'op_runtime0001', 'evt_runtime0001:r1', 'committed',
  'selection-intent:intent_runtime0001', 1,
  array['agent-artifact:art_runtimeoutput1']::text[]
);
-- Simulate a committed database response that the Activity did not receive.
insert into science_v3_operation_result (
  tenant_id, operation_id, idempotency_key, result_status, aggregate_ref,
  aggregate_version, result_resource_refs
) values (
  'tnt_dev00001', 'op_runtime0001', 'evt_runtime0001:r1', 'committed',
  'selection-intent:intent_runtime0001', 1,
  array['agent-artifact:art_runtimeoutput1']::text[]
) on conflict (operation_id, idempotency_key) do nothing;

update science_v3_operation
   set status = 'succeeded', user_message = '处理完成',
       related_resource_refs = array['agent-artifact:art_runtimeoutput1']::text[],
       updated_at = clock_timestamp(), version = version + 1
 where tenant_id = 'tnt_dev00001' and operation_id = 'op_runtime0001';

do $$
declare
  correlation_count integer;
  attempt_count integer;
  result_count integer;
  delivery_count integer;
  final_status text;
begin
  select count(*) into correlation_count from science_v3_workflow_correlation
   where event_id = 'evt_runtime0001';
  select count(*) into attempt_count from science_v3_agent_attempt
   where operation_id = 'op_runtime0001';
  select count(*) into result_count from science_v3_operation_result
   where operation_id = 'op_runtime0001' and idempotency_key = 'evt_runtime0001:r1';
  select delivery_attempts into delivery_count from infra_outbox
   where event_id = 'evt_runtime0001';
  select status into final_status from science_v3_operation
   where operation_id = 'op_runtime0001';
  if correlation_count <> 1 or delivery_count <> 1 then
    raise exception 'outbox acknowledgement is not idempotent';
  end if;
  if attempt_count <> 2 then
    raise exception 'workflow run identities collided';
  end if;
  if result_count <> 1 or final_status <> 'succeeded' then
    raise exception 'operation result is not idempotent';
  end if;
end
$$;

rollback;
