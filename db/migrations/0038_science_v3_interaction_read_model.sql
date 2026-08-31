-- 0038: app-owned foreground messages and authorized client invalidations.
--
-- This migration extends only the science-v3 authority. It deliberately does
-- not read, backfill, dual-write or depend on legacy Pi/thread/card tables.
begin;

alter table science_v3_operation
  drop constraint if exists science_v3_operation_kind_check;
alter table science_v3_operation
  add constraint science_v3_operation_kind_check check (kind in (
    'submit_attempt','finalize_question','select_question','start_review',
    'annotation_feedback','teacher_correction','dream','foreground_teaching'
  ));

alter table science_v3_conversation_thread
  add column title text not null default '新对话'
    check (length(title) between 1 and 120);

create table science_v3_foreground_request (
  foreground_request_id  text primary key check (foreground_request_id ~ '^fgr_[A-Za-z0-9]{8,}$'),
  tenant_id               text not null references identity_tenant(tenant_id),
  operation_id            text not null,
  conversation_thread_id  text not null,
  student_id              text not null,
  foreground_epoch_id     text not null,
  triggering_message_id   text not null,
  input_artifact_id       text not null,
  event_id                text not null,
  idempotency_key         text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  command_sha256          text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
  expected_thread_version bigint not null check (expected_thread_version > 0),
  status                   text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  response_message_id      text,
  output_ref               text check (output_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  requested_at             timestamptz not null,
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  unique (tenant_id,foreground_request_id),
  unique (tenant_id,operation_id),
  unique (tenant_id,event_id),
  unique (tenant_id,idempotency_key),
  unique (tenant_id,triggering_message_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,conversation_thread_id)
    references science_v3_conversation_thread(tenant_id,conversation_thread_id),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  foreign key (tenant_id,foreground_epoch_id)
    references science_v3_foreground_agent_epoch(tenant_id,foreground_epoch_id),
  foreign key (tenant_id,triggering_message_id)
    references science_v3_canonical_message(tenant_id,message_id),
  foreign key (tenant_id,input_artifact_id)
    references science_v3_agent_artifact(tenant_id,artifact_id),
  foreign key (tenant_id,response_message_id)
    references science_v3_canonical_message(tenant_id,message_id),
  check (
    (status in ('queued','running') and response_message_id is null and completed_at is null)
    or (status='succeeded' and response_message_id is not null and output_ref is not null and completed_at is not null)
    or (status in ('failed','cancelled') and response_message_id is null and completed_at is not null)
  )
);
create index science_v3_foreground_request_thread_idx
  on science_v3_foreground_request(tenant_id,conversation_thread_id,requested_at desc);

create table science_v3_learning_action (
  learning_action_id      text primary key check (learning_action_id ~ '^lna_[A-Za-z0-9]{8,}$'),
  tenant_id               text not null references identity_tenant(tenant_id),
  foreground_request_id   text not null,
  operation_id            text not null,
  agent_attempt_id        text not null,
  tool_call_id            text not null check (length(tool_call_id) between 1 and 255),
  action_type             text not null check (action_type in ('request_cut','revise_selection_intent','present_validated_artifact')),
  action_payload          jsonb not null,
  payload_sha256          text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  accepted                boolean not null,
  result_resource_ref     text check (result_resource_ref ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  rejection_code          text check (rejection_code in ('no_active_question','stale','invalid','conflict','permission_denied')),
  occurred_at             timestamptz not null default now(),
  unique (tenant_id,learning_action_id),
  unique (tenant_id,agent_attempt_id,tool_call_id),
  foreign key (tenant_id,foreground_request_id)
    references science_v3_foreground_request(tenant_id,foreground_request_id),
  foreign key (tenant_id,operation_id)
    references science_v3_operation(tenant_id,operation_id),
  foreign key (tenant_id,agent_attempt_id)
    references science_v3_agent_attempt(tenant_id,agent_attempt_id),
  check (jsonb_typeof(action_payload)='object' and pg_column_size(action_payload)<=1048576),
  check (accepted=(result_resource_ref is not null)),
  check (accepted=(rejection_code is null))
);
create index science_v3_learning_action_request_idx
  on science_v3_learning_action(tenant_id,foreground_request_id,occurred_at);

-- This table is an invalidation log, not a second event bus. It contains no
-- answers, message text, annotation claims or cross-student PII.
create table science_v3_client_event (
  cursor             bigint generated always as identity primary key,
  event_id           text not null unique check (event_id ~ '^cev_[A-Za-z0-9]{8,}$'),
  tenant_id          text not null references identity_tenant(tenant_id),
  student_id         text,
  audience_user_id   text references identity_user(user_id),
  event_type         text not null check (event_type in (
    'canonical_message.appended','canonical_message.updated',
    'learning_resource.changed','learning_operation.changed'
  )),
  resource_key       text not null check (resource_key ~ '^[a-z][a-z0-9+.-]*:[^[:space:]]+$'),
  resource_version   bigint not null check (resource_version > 0),
  occurred_at        timestamptz not null default now(),
  foreign key (tenant_id,student_id)
    references science_v3_student(tenant_id,student_id),
  check (student_id is not null or audience_user_id is not null)
);
create index science_v3_client_event_tenant_cursor_idx
  on science_v3_client_event(tenant_id,cursor);
create index science_v3_client_event_student_cursor_idx
  on science_v3_client_event(tenant_id,student_id,cursor) where student_id is not null;
create index science_v3_client_event_audience_cursor_idx
  on science_v3_client_event(tenant_id,audience_user_id,cursor) where audience_user_id is not null;

create or replace function science_v3_foreground_request_guard() returns trigger as $$
begin
  if TG_OP='DELETE' then raise exception 'science-v3 foreground request cannot be deleted'; end if;
  if row(new.foreground_request_id,new.tenant_id,new.operation_id,new.conversation_thread_id,
         new.student_id,new.foreground_epoch_id,new.triggering_message_id,new.input_artifact_id,
         new.event_id,new.idempotency_key,new.command_sha256,new.expected_thread_version,new.requested_at)
     is distinct from
     row(old.foreground_request_id,old.tenant_id,old.operation_id,old.conversation_thread_id,
         old.student_id,old.foreground_epoch_id,old.triggering_message_id,old.input_artifact_id,
         old.event_id,old.idempotency_key,old.command_sha256,old.expected_thread_version,old.requested_at) then
    raise exception 'science-v3 foreground request identity and input are immutable';
  end if;
  if new.updated_at<=old.updated_at then
    raise exception 'science-v3 foreground request update must advance updated_at';
  end if;
  if old.status<>new.status and not (
    (old.status='queued' and new.status in ('running','failed','cancelled'))
    or (old.status='running' and new.status in ('succeeded','failed','cancelled'))
  ) then
    raise exception 'invalid foreground request transition % -> %',old.status,new.status;
  end if;
  return new;
end
$$ language plpgsql;
create trigger science_v3_foreground_request_guard
  before update or delete on science_v3_foreground_request
  for each row execute function science_v3_foreground_request_guard();

create trigger science_v3_learning_action_immutable
  before update or delete on science_v3_learning_action
  for each row execute function forbid_mutation();
create trigger science_v3_client_event_immutable
  before update or delete on science_v3_client_event
  for each row execute function forbid_mutation();

create or replace function science_v3_new_client_event_id() returns text as $$
  select 'cev_' || substr(md5(clock_timestamp()::text || random()::text || txid_current()::text),1,24)
$$ language sql volatile;

create or replace function science_v3_emit_message_client_event() returns trigger as $$
declare
  v_student_id text;
  v_user_id text;
begin
  select thread.student_id,student.user_id into v_student_id,v_user_id
    from science_v3_conversation_thread thread
    join science_v3_student student
      on student.tenant_id=thread.tenant_id and student.student_id=thread.student_id
   where thread.tenant_id=new.tenant_id
     and thread.conversation_thread_id=new.conversation_thread_id;
  insert into science_v3_client_event(
    event_id,tenant_id,student_id,audience_user_id,event_type,resource_key,resource_version,occurred_at
  ) values (
    science_v3_new_client_event_id(),new.tenant_id,v_student_id,v_user_id,
    case when TG_OP='INSERT' then 'canonical_message.appended' else 'canonical_message.updated' end,
    'canonical-message:' || new.message_id,new.version,clock_timestamp()
  );
  return new;
end
$$ language plpgsql;
create trigger science_v3_canonical_message_client_event
  after insert or update on science_v3_canonical_message
  for each row execute function science_v3_emit_message_client_event();

create or replace function science_v3_emit_operation_client_event() returns trigger as $$
declare
  v_student_id text;
begin
  select request.student_id into v_student_id
    from science_v3_foreground_request request
   where request.tenant_id=new.tenant_id and request.operation_id=new.operation_id;
  insert into science_v3_client_event(
    event_id,tenant_id,student_id,audience_user_id,event_type,resource_key,resource_version,occurred_at
  ) values (
    science_v3_new_client_event_id(),new.tenant_id,v_student_id,new.requested_by_user_id,
    'learning_operation.changed','operation:' || new.operation_id,new.version,clock_timestamp()
  );
  return new;
end
$$ language plpgsql;
create trigger science_v3_operation_client_event
  after insert or update on science_v3_operation
  for each row execute function science_v3_emit_operation_client_event();

create or replace function science_v3_emit_resource_client_event() returns trigger as $$
declare
  v_row jsonb := to_jsonb(new);
  v_student_id text := v_row->>'student_id';
  v_resource_id text := v_row->>TG_ARGV[1];
  v_version bigint := coalesce((v_row->>TG_ARGV[2])::bigint,1);
  v_user_id text;
begin
  if v_student_id is null or v_resource_id is null then return new; end if;
  select student.user_id into v_user_id
    from science_v3_student student
   where student.tenant_id=new.tenant_id and student.student_id=v_student_id;
  insert into science_v3_client_event(
    event_id,tenant_id,student_id,audience_user_id,event_type,resource_key,resource_version,occurred_at
  ) values (
    science_v3_new_client_event_id(),new.tenant_id,v_student_id,v_user_id,
    'learning_resource.changed',TG_ARGV[0] || ':' || v_resource_id,v_version,clock_timestamp()
  );
  return new;
end
$$ language plpgsql;
create trigger science_v3_question_session_client_event
  after insert or update on science_v3_question_session
  for each row execute function science_v3_emit_resource_client_event('question-session','question_session_id','version');
create trigger science_v3_mastery_projection_client_event
  after insert or update on science_v3_mastery_projection
  for each row execute function science_v3_emit_resource_client_event('mastery-projection','dimension_id','projection_version');
create trigger science_v3_retention_projection_client_event
  after insert or update on science_v3_retention_projection
  for each row execute function science_v3_emit_resource_client_event('retention-projection','retention_unit_revision_id','projection_version');
create trigger science_v3_error_pattern_client_event
  after insert or update on science_v3_error_pattern_projection
  for each row execute function science_v3_emit_resource_client_event('error-pattern','error_cause_id','projection_version');
create trigger science_v3_annotation_client_event
  after insert on science_v3_semantic_annotation
  for each row execute function science_v3_emit_resource_client_event('annotation','annotation_id','set_version');

-- Ordinary user messages enter the same durable outbox as every other
-- asynchronous domain request. The HTTP response is therefore independent of
-- Temporal availability and retries cannot duplicate a canonical message.
create or replace function mathpilot_science_v3_submit_foreground_message(
  p_tenant_id text,
  p_requested_by_user_id text,
  p_foreground_request_id text,
  p_operation_id text,
  p_event_id text,
  p_artifact_id text,
  p_message_id text,
  p_foreground_epoch_id text,
  p_conversation_thread_id text,
  p_idempotency_key text,
  p_command_sha256 text,
  p_expected_thread_version bigint,
  p_parts jsonb,
  p_input_payload jsonb,
  p_input_sha256 text,
  p_requested_at timestamptz
) returns table (
  foreground_request_id text,
  operation_id text,
  canonical_message_id text,
  foreground_epoch_id text,
  thread_version bigint,
  created boolean
)
language plpgsql
as $$
declare
  v_existing science_v3_foreground_request%rowtype;
  v_thread science_v3_conversation_thread%rowtype;
  v_student science_v3_student%rowtype;
  v_epoch science_v3_foreground_agent_epoch%rowtype;
  v_new_thread_version bigint;
begin
  select * into v_existing from science_v3_foreground_request
   where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.command_sha256<>p_command_sha256 then
      raise exception 'idempotency key is bound to another foreground command';
    end if;
    select version into v_new_thread_version from science_v3_conversation_thread
     where tenant_id=p_tenant_id and science_v3_conversation_thread.conversation_thread_id=v_existing.conversation_thread_id;
    return query select v_existing.foreground_request_id,v_existing.operation_id,
      v_existing.triggering_message_id,v_existing.foreground_epoch_id,v_new_thread_version,false;
    return;
  end if;
  if jsonb_typeof(p_parts)<>'array' or jsonb_array_length(p_parts)<1
     or pg_column_size(p_parts)>1048576 or jsonb_typeof(p_input_payload)<>'object'
     or pg_column_size(p_input_payload)>1048576 or p_input_sha256!~'^[0-9a-f]{64}$'
     or p_command_sha256!~'^[0-9a-f]{64}$' then
    raise exception 'invalid foreground message payload';
  end if;

  select * into v_thread from science_v3_conversation_thread
   where tenant_id=p_tenant_id
     and science_v3_conversation_thread.conversation_thread_id=p_conversation_thread_id
   for update;
  if not found or v_thread.status<>'active' then raise exception 'active conversation thread not found'; end if;
  select * into v_student from science_v3_student
   where tenant_id=p_tenant_id and student_id=v_thread.student_id;
  if not found or v_student.user_id<>p_requested_by_user_id then
    raise exception 'conversation thread does not belong to requested user';
  end if;
  if v_thread.version<>p_expected_thread_version then
    raise exception 'thread version conflict: current version is %',v_thread.version;
  end if;

  select * into v_epoch from science_v3_foreground_agent_epoch
   where tenant_id=p_tenant_id and conversation_thread_id=p_conversation_thread_id and ended_at is null;
  if not found then
    insert into science_v3_foreground_agent_epoch(
      foreground_epoch_id,tenant_id,conversation_thread_id,student_id,
      active_question_session_id,context_snapshot_ref,workspace_snapshot_version,started_at
    ) values (
      p_foreground_epoch_id,p_tenant_id,p_conversation_thread_id,v_thread.student_id,
      null,'workspace-projection:' || p_conversation_thread_id || '@' || v_thread.version,
      v_thread.version,p_requested_at
    ) returning * into v_epoch;
  end if;
  if p_input_payload->>'request_id'<>p_foreground_request_id
     or p_input_payload->>'conversation_thread_id'<>p_conversation_thread_id
     or p_input_payload->>'foreground_epoch_id'<>v_epoch.foreground_epoch_id
     or p_input_payload->>'student_id'<>v_thread.student_id
     or p_input_payload->>'triggering_message_id'<>p_message_id then
    raise exception 'foreground input binding mismatch';
  end if;

  insert into science_v3_operation(
    operation_id,tenant_id,requested_by_user_id,kind,status,user_message,related_resource_refs
  ) values (
    p_operation_id,p_tenant_id,p_requested_by_user_id,'foreground_teaching','accepted',
    '正在思考并整理回复',array['canonical-message:' || p_message_id]
  );
  insert into science_v3_agent_artifact(
    artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
  ) values (
    p_artifact_id,p_tenant_id,p_operation_id,'input_bundle',
    'https://schemas.mathpilot.dev/science-v3/foreground-teaching-input/v1',
    p_input_payload,p_input_sha256
  );
  insert into science_v3_canonical_message(
    message_id,tenant_id,conversation_thread_id,sequence,author_kind,author_user_id,
    foreground_epoch_id,lifecycle,parts,question_session_id,editable,lock_reason,created_at,version
  ) values (
    p_message_id,p_tenant_id,p_conversation_thread_id,v_thread.next_message_sequence,
    'student',p_requested_by_user_id,v_epoch.foreground_epoch_id,'committed',p_parts,
    v_epoch.active_question_session_id,false,'domain_event',p_requested_at,1
  );
  insert into science_v3_foreground_request(
    foreground_request_id,tenant_id,operation_id,conversation_thread_id,student_id,
    foreground_epoch_id,triggering_message_id,input_artifact_id,event_id,idempotency_key,
    command_sha256,expected_thread_version,status,requested_at,updated_at
  ) values (
    p_foreground_request_id,p_tenant_id,p_operation_id,p_conversation_thread_id,v_thread.student_id,
    v_epoch.foreground_epoch_id,p_message_id,p_artifact_id,p_event_id,p_idempotency_key,
    p_command_sha256,p_expected_thread_version,'queued',p_requested_at,clock_timestamp()
  );
  v_new_thread_version:=v_thread.version+1;
  update science_v3_conversation_thread
     set next_message_sequence=next_message_sequence+1,updated_at=clock_timestamp(),version=v_new_thread_version
   where tenant_id=p_tenant_id and science_v3_conversation_thread.conversation_thread_id=p_conversation_thread_id;
  insert into infra_outbox(
    event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
    causation_id,occurred_at,aggregate_version,payload_ref,operation_id
  ) values (
    p_event_id,p_tenant_id,'conversation-thread',p_conversation_thread_id,
    'foreground.message_submitted','{}'::jsonb,p_operation_id,p_idempotency_key,
    p_requested_at,v_new_thread_version,'agent-artifact:' || p_artifact_id,p_operation_id
  );
  return query select p_foreground_request_id,p_operation_id,p_message_id,
    v_epoch.foreground_epoch_id,v_new_thread_version,true;
end
$$;

create or replace function mathpilot_science_v3_commit_foreground_response(
  p_tenant_id text,
  p_foreground_request_id text,
  p_response_message_id text,
  p_parts jsonb,
  p_output_ref text,
  p_completed_at timestamptz
) returns table (canonical_message_id text,thread_version bigint,created boolean)
language plpgsql
as $$
declare
  v_request science_v3_foreground_request%rowtype;
  v_thread science_v3_conversation_thread%rowtype;
  v_version bigint;
begin
  select * into v_request from science_v3_foreground_request
   where tenant_id=p_tenant_id and science_v3_foreground_request.foreground_request_id=p_foreground_request_id
   for update;
  if not found then raise exception 'foreground request not found'; end if;
  if v_request.status='succeeded' then
    select version into v_version from science_v3_conversation_thread
     where tenant_id=p_tenant_id and conversation_thread_id=v_request.conversation_thread_id;
    return query select v_request.response_message_id,v_version,false;
    return;
  end if;
  if v_request.status not in ('queued','running') then raise exception 'foreground request is terminal'; end if;
  if jsonb_typeof(p_parts)<>'array' or jsonb_array_length(p_parts)<1
     or pg_column_size(p_parts)>1048576
     or p_output_ref!~'^[a-z][a-z0-9+.-]*:[^[:space:]]+$' then
    raise exception 'invalid foreground response';
  end if;
  select * into v_thread from science_v3_conversation_thread
   where tenant_id=p_tenant_id and conversation_thread_id=v_request.conversation_thread_id
   for update;
  insert into science_v3_canonical_message(
    message_id,tenant_id,conversation_thread_id,sequence,author_kind,author_user_id,
    foreground_epoch_id,lifecycle,parts,reply_to_message_id,question_session_id,
    editable,lock_reason,created_at,version
  ) values (
    p_response_message_id,p_tenant_id,v_request.conversation_thread_id,v_thread.next_message_sequence,
    'assistant',null,v_request.foreground_epoch_id,'committed',p_parts,
    v_request.triggering_message_id,
    (select active_question_session_id from science_v3_foreground_agent_epoch
      where tenant_id=p_tenant_id and foreground_epoch_id=v_request.foreground_epoch_id),
    false,'domain_event',p_completed_at,1
  );
  v_version:=v_thread.version+1;
  update science_v3_conversation_thread
     set next_message_sequence=next_message_sequence+1,updated_at=clock_timestamp(),version=v_version
   where tenant_id=p_tenant_id and conversation_thread_id=v_request.conversation_thread_id;
  update science_v3_foreground_request
     set status='succeeded',response_message_id=p_response_message_id,output_ref=p_output_ref,
         completed_at=p_completed_at,updated_at=clock_timestamp()
   where tenant_id=p_tenant_id and science_v3_foreground_request.foreground_request_id=p_foreground_request_id;
  insert into science_v3_operation_result(
    tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
    aggregate_version,result_resource_refs
  ) values (
    p_tenant_id,v_request.operation_id,v_request.idempotency_key,'committed',
    'conversation-thread:' || v_request.conversation_thread_id,v_version,
    array['canonical-message:' || p_response_message_id,p_output_ref]
  ) on conflict(operation_id,idempotency_key) do nothing;
  update science_v3_operation
     set status='succeeded',user_message='回复已完成',retryable=false,
         related_resource_refs=array['canonical-message:' || p_response_message_id],
         updated_at=clock_timestamp(),version=version+1
   where tenant_id=p_tenant_id and operation_id=v_request.operation_id and status='running';
  return query select p_response_message_id,v_version,true;
end
$$;

alter table infra_outbox
  drop constraint if exists infra_outbox_science_v3_envelope_check;
alter table infra_outbox
  add constraint infra_outbox_science_v3_envelope_check check (
    event_type not in (
      'question.cut_requested','selection.intent_revised','question.closed',
      'dream.rem_requested','dream.deep_requested','teacher.correction_recorded',
      'foreground.message_submitted'
    ) or (
      aggregate_version>0
      and payload_ref~'^[a-z][a-z0-9+.-]*:[^[:space:]]+$'
      and operation_id~'^op_[A-Za-z0-9]{8,}$'
      and payload='{}'::jsonb
    )
  );
drop index if exists infra_outbox_science_v3_pending_idx;
create index infra_outbox_science_v3_pending_idx
  on infra_outbox(occurred_at,event_id)
  where published_at is null and event_type in (
    'question.cut_requested','selection.intent_revised','question.closed',
    'dream.rem_requested','dream.deep_requested','teacher.correction_recorded',
    'foreground.message_submitted'
  );

create or replace function mathpilot_science_v3_pending_workflow_starts(p_limit integer default 32)
returns table (
  event_id text,tenant_id text,operation_id text,event_type text,
  aggregate_ref text,aggregate_version bigint,payload_ref text,
  occurred_at timestamptz,delivery_attempts integer
)
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
begin
  if p_limit<1 or p_limit>100 then raise exception 'p_limit must be between 1 and 100'; end if;
  return query
    select o.event_id,o.tenant_id,o.operation_id,o.event_type,
           o.aggregate_type || ':' || o.aggregate_id,o.aggregate_version,
           o.payload_ref,o.occurred_at,o.delivery_attempts
      from public.infra_outbox o
     where o.published_at is null
       and o.event_type in (
         'question.cut_requested','selection.intent_revised','question.closed',
         'dream.rem_requested','dream.deep_requested','teacher.correction_recorded',
         'foreground.message_submitted'
       )
     order by o.occurred_at,o.event_id
     limit p_limit;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_started(
  p_event_id text,p_workflow_id text,p_task_queue text
) returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  target public.infra_outbox%rowtype;
  expected_workflow_id text;
  existing public.science_v3_workflow_correlation%rowtype;
begin
  if p_task_queue!~'^[a-z][a-z0-9_-]{1,119}$' then raise exception 'invalid task queue'; end if;
  select * into target from public.infra_outbox o
   where o.event_id=p_event_id and o.event_type in (
     'question.cut_requested','selection.intent_revised','question.closed',
     'dream.rem_requested','dream.deep_requested','teacher.correction_recorded',
     'foreground.message_submitted'
   );
  if not found then return false; end if;
  if target.event_type='selection.intent_revised' and target.aggregate_type='conversation-thread' then
    expected_workflow_id:='select-question:' || target.tenant_id || ':' || target.aggregate_id;
  else
    expected_workflow_id:=target.event_type || ':' || target.event_id;
  end if;
  if p_workflow_id<>expected_workflow_id then raise exception 'workflow ID must be %',expected_workflow_id; end if;
  insert into public.science_v3_workflow_correlation(
    event_id,tenant_id,operation_id,workflow_id,aggregate_ref,aggregate_version,task_queue
  ) values (
    target.event_id,target.tenant_id,target.operation_id,p_workflow_id,
    target.aggregate_type || ':' || target.aggregate_id,target.aggregate_version,p_task_queue
  ) on conflict(event_id) do nothing;
  select * into existing from public.science_v3_workflow_correlation where event_id=p_event_id;
  if existing.workflow_id<>p_workflow_id or existing.task_queue<>p_task_queue then
    raise exception 'event already correlated to a different Workflow';
  end if;
  update public.infra_outbox o
     set published_at=coalesce(o.published_at,now()),workflow_id=p_workflow_id,
         delivery_attempts=case when o.published_at is null then o.delivery_attempts+1 else o.delivery_attempts end,
         last_delivery_attempt_at=case when o.published_at is null then now() else o.last_delivery_attempt_at end,
         last_delivery_error=null
   where o.event_id=p_event_id;
  return true;
end
$$;

create or replace function mathpilot_science_v3_mark_workflow_start_failed(
  p_event_id text,p_error text
) returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
begin
  update public.infra_outbox o
     set delivery_attempts=o.delivery_attempts+1,last_delivery_attempt_at=now(),
         last_delivery_error=left(coalesce(p_error,'unknown error'),1000)
   where o.event_id=p_event_id and o.published_at is null
     and o.event_type in (
       'question.cut_requested','selection.intent_revised','question.closed',
       'dream.rem_requested','dream.deep_requested','teacher.correction_recorded',
       'foreground.message_submitted'
     );
  return found;
end
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'science_v3_foreground_request','science_v3_learning_action','science_v3_client_event'
  ] loop
    execute format('alter table %I enable row level security',t);
    execute format('alter table %I force row level security',t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id=current_setting(''app.current_tenant'',true)) with check (tenant_id=current_setting(''app.current_tenant'',true))',t
    );
  end loop;
end
$$;

revoke all on function mathpilot_science_v3_submit_foreground_message(
  text,text,text,text,text,text,text,text,text,text,text,bigint,jsonb,jsonb,text,timestamptz
) from public;
revoke all on function mathpilot_science_v3_commit_foreground_response(
  text,text,text,jsonb,text,timestamptz
) from public;

do $$
begin
  if exists(select 1 from pg_roles where rolname='mathpilot_app') then
    grant select,insert,update on science_v3_foreground_request to mathpilot_app;
    grant select,insert on science_v3_learning_action to mathpilot_app;
    grant select,insert on science_v3_client_event to mathpilot_app;
    grant usage,select on sequence science_v3_client_event_cursor_seq to mathpilot_app;
    grant execute on function mathpilot_science_v3_submit_foreground_message(
      text,text,text,text,text,text,text,text,text,text,text,bigint,jsonb,jsonb,text,timestamptz
    ) to mathpilot_app;
    grant execute on function mathpilot_science_v3_commit_foreground_response(
      text,text,text,jsonb,text,timestamptz
    ) to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0038_science_v3_interaction_read_model');
commit;
