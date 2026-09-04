-- 0059: 0058 added tool_trace but did not extend AgentAttempt's update guard.
-- Completing an attempt with a real tool trace must be allowed; all other
-- immutable columns remain protected by the same shared trigger function.
begin;

drop trigger science_v3_agent_attempt_guard on science_v3_agent_attempt;
create trigger science_v3_agent_attempt_guard before update on science_v3_agent_attempt
  for each row execute function forbid_mutation_except(
    'status', 'output_ref', 'resolved_model_id', 'input_tokens', 'output_tokens',
    'error_code', 'error_detail', 'completed_at', 'workspace_manifest', 'tool_trace'
  );

insert into infra_schema_migration(version) values ('0059_agent_attempt_tool_trace_guard');
commit;
