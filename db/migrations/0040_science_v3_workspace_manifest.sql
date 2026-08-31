-- 0040: persist the exact user-visible manifest for each authorized WorkspaceProjection.
begin;

alter table science_v3_agent_attempt
  add column workspace_manifest jsonb;

alter table science_v3_agent_attempt
  add constraint science_v3_agent_attempt_workspace_manifest_check check (
    workspace_manifest is null or (
      jsonb_typeof(workspace_manifest)='object'
      and workspace_manifest->>'schema'='mathpilot.agent-context-manifest/v1'
      and length(workspace_manifest->>'manifest_ref') between 1 and 255
      and workspace_manifest->>'foreground_epoch_id' ~ '^fge_[A-Za-z0-9]{8,}$'
      and jsonb_typeof(workspace_manifest->'snapshot_version')='number'
      and jsonb_typeof(workspace_manifest->'generated_at')='string'
      and jsonb_typeof(workspace_manifest->'items')='array'
      and octet_length(workspace_manifest::text) <= 1048576
    )
  );

create or replace function science_v3_agent_attempt_manifest_guard() returns trigger as $$
begin
  if OLD.workspace_manifest is not null
     and NEW.workspace_manifest is distinct from OLD.workspace_manifest then
    raise exception 'science-v3 AgentAttempt WorkspaceProjection manifest is immutable';
  end if;
  return NEW;
end
$$ language plpgsql;

drop trigger science_v3_agent_attempt_guard on science_v3_agent_attempt;
create trigger science_v3_agent_attempt_guard before update on science_v3_agent_attempt
  for each row execute function forbid_mutation_except(
    'status', 'output_ref', 'resolved_model_id', 'input_tokens', 'output_tokens',
    'error_code', 'error_detail', 'completed_at', 'workspace_manifest'
  );
create trigger science_v3_agent_attempt_manifest_guard before update on science_v3_agent_attempt
  for each row execute function science_v3_agent_attempt_manifest_guard();

insert into infra_schema_migration(version) values ('0040_science_v3_workspace_manifest');
commit;
