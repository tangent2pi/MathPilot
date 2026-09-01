-- 0041: one immutable object lifecycle, one Science-v3 access projection, and
-- one attachment/avatar binding authority for every Next byte-bearing flow.
--
-- This migration intentionally removes the abandoned bytea avatar shape. It
-- is not a compatibility layer: browser uploads enter a quarantine object,
-- storage-next publishes only a verified canonical version, and consumers
-- retain the exact version/size/digest descriptor they claimed.
begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage-owned lifecycle and immutable source/stored provenance
-- ─────────────────────────────────────────────────────────────────────────────
alter table storage_object
  add column declared_byte_size bigint,
  add column declared_mime_type text,
  add column source_object_key text,
  add column source_version_id text,
  add column source_etag text,
  add column source_sha256 text,
  add column source_byte_size bigint,
  add column source_mime_type text,
  add column expires_at timestamptz,
  add column verification_lease_id text,
  add column verification_started_at timestamptz,
  add column verification_attempts integer not null default 0,
  add column last_failure_code text,
  add column last_failure_at timestamptz,
  add column deletion_lease_id text,
  add column deletion_started_at timestamptz,
  add column deletion_attempts integer not null default 0,
  add column deleted_at timestamptz;

alter table storage_object
  alter column byte_size drop not null,
  alter column mime_type drop not null;

alter table storage_object
  drop constraint if exists storage_object_purpose_check,
  drop constraint if exists storage_object_state_check;

-- Rows written by the earlier partial PUT implementation are either complete
-- immutable versions or are retired. An unversioned row is never promoted to
-- ready merely because legacy metadata said so.
update storage_object
   set original_name=coalesce(nullif(btrim(original_name),''),'object'),
       declared_byte_size=greatest(coalesce(byte_size,0),1),
       declared_mime_type=coalesce(nullif(split_part(mime_type,';',1),''),'application/octet-stream'),
       source_object_key=object_key,
       expires_at=case
         when state='ready' and version_id is not null and sha256 is not null then now()+interval '24 hours'
         else now()
       end;

update storage_object
   set source_version_id=version_id,
       source_etag=etag,
       source_sha256=sha256,
       source_byte_size=byte_size,
       source_mime_type=mime_type
 where state='ready' and version_id is not null and sha256 is not null
   and byte_size is not null and byte_size>0 and mime_type is not null;

update storage_object
   set state='failed',
       last_failure_code='pre_integrity_object_retired',
       last_failure_at=now(),
       expires_at=now()
 where state in ('pending','ready')
   and (source_version_id is null or source_sha256 is null
     or source_byte_size is null or source_byte_size<1 or source_mime_type is null);

-- The retired implementation could leave a tombstone without tombstone
-- metadata. Preserve the lifecycle fact, but make it legal in the final
-- state machine before constraints are validated.
update storage_object
   set deleted_at=coalesce(verified_at,created_at,now()),
       expires_at=null,
       verification_lease_id=null,
       verification_started_at=null,
       deletion_lease_id=null,
       deletion_started_at=null
 where state='deleted';

alter table storage_object
  alter column declared_byte_size set not null,
  alter column declared_mime_type set not null,
  alter column source_object_key set not null,
  alter column original_name set not null,
  add constraint storage_object_declared_size_check
    check (declared_byte_size between 1 and 50331648),
  add constraint storage_object_declared_mime_check
    check (length(declared_mime_type) between 3 and 160),
  add constraint storage_object_source_key_check
    check (source_object_key !~ '(^|/)(\.\.?)(/|$)' and source_object_key !~ '[\\\x00]'),
  add constraint storage_object_purpose_check
    check (purpose in ('source','candidate','package','thread','avatar','derived')),
  add constraint storage_object_state_check
    check (state in ('pending','verifying','ready','failed','deleting','deleted')),
  add constraint storage_object_source_sha_check
    check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint storage_object_source_size_check
    check (source_byte_size is null or source_byte_size between 1 and 50331648),
  add constraint storage_object_verification_attempts_check
    check (verification_attempts between 0 and 16),
  add constraint storage_object_deletion_attempts_check
    check (deletion_attempts>=0),
  add constraint storage_object_lifecycle_shape_check check (
    ((state='verifying' and verification_lease_id is not null and verification_started_at is not null)
      or (state<>'verifying' and verification_lease_id is null and verification_started_at is null))
    and ((state='deleting' and ((deletion_lease_id is null and deletion_started_at is null)
             or (deletion_lease_id is not null and deletion_started_at is not null)))
      or (state<>'deleting' and deletion_lease_id is null and deletion_started_at is null))
  ),
  add constraint storage_object_ready_shape_check check (
    state<>'ready' or (
      version_id is not null and sha256 is not null and byte_size is not null and byte_size>0
      and mime_type is not null and source_version_id is not null and source_sha256 is not null
      and source_byte_size is not null and source_mime_type is not null and verified_at is not null
    )
  ),
  add constraint storage_object_expiry_shape_check check (
    (state in ('pending','verifying','failed','deleting') and expires_at is not null)
    or state='ready'
    or (state='deleted' and expires_at is null)
  ),
  add constraint storage_object_deleted_shape_check check (
    (state='deleted' and deleted_at is not null)
    or (state<>'deleted' and deleted_at is null)
  );

create index storage_object_expiry_idx
  on storage_object(state,expires_at) where state in ('pending','verifying','ready','failed','deleting');
alter table storage_object add constraint storage_object_tenant_object_unique unique(tenant_id,object_id);

-- Retention is many-to-one. A verified object may be cited by more than one
-- candidate while still having at most one exclusive UI/audit binding. Each
-- claim freezes the exact descriptor so domains never reconstruct identity
-- from mutable request metadata or expiring URLs.
create table storage_object_claim (
  tenant_id          text not null,
  object_id          text not null,
  claim_kind         text not null check (
    claim_kind in ('thread_attachment','avatar','candidate_result','candidate_receipt','content_source')
  ),
  claim_ref          text not null check (length(claim_ref) between 3 and 255),
  version_id         text not null,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size          bigint not null check (byte_size between 1 and 50331648),
  mime_type          text not null,
  original_name      text not null,
  source_version_id  text not null,
  source_sha256      text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size   bigint not null check (source_byte_size between 1 and 50331648),
  source_mime_type   text not null,
  claimed_at         timestamptz not null default clock_timestamp(),
  primary key(tenant_id,object_id,claim_kind,claim_ref),
  foreign key(tenant_id,object_id) references storage_object(tenant_id,object_id)
);
create index storage_object_claim_ref_idx
  on storage_object_claim(tenant_id,claim_kind,claim_ref,object_id);
create unique index storage_object_claim_exclusive_idx
  on storage_object_claim(tenant_id,object_id)
  where claim_kind in ('thread_attachment','avatar','candidate_result','candidate_receipt');

create or replace function mathpilot_storage_object_guard() returns trigger
language plpgsql as $$
begin
  if TG_OP='DELETE' then
    raise exception 'storage object rows are lifecycle facts and cannot be deleted';
  end if;
  if row(new.object_id,new.tenant_id,new.bucket_name,new.source_object_key,
         new.declared_byte_size,new.declared_mime_type,new.original_name,
         new.owner_user_id,new.purpose,new.created_at)
     is distinct from
     row(old.object_id,old.tenant_id,old.bucket_name,old.source_object_key,
         old.declared_byte_size,old.declared_mime_type,old.original_name,
         old.owner_user_id,old.purpose,old.created_at) then
    raise exception 'storage object identity and declaration are immutable';
  end if;
  if old.state<>new.state and not (
    (old.state='pending' and new.state in ('verifying','failed','deleting'))
    or (old.state='verifying' and new.state in ('pending','ready','failed','deleting'))
    or (old.state='ready' and new.state='deleting')
    or (old.state='failed' and new.state='deleting')
    or (old.state='deleting' and new.state='deleted')
  ) then
    raise exception 'invalid storage object transition % -> %',old.state,new.state;
  end if;
  if old.state='ready' and row(
       new.object_key,new.version_id,new.etag,new.sha256,new.byte_size,new.mime_type,
       new.source_version_id,new.source_etag,new.source_sha256,new.source_byte_size,
       new.source_mime_type,new.verified_at
     ) is distinct from row(
       old.object_key,old.version_id,old.etag,old.sha256,old.byte_size,old.mime_type,
       old.source_version_id,old.source_etag,old.source_sha256,old.source_byte_size,
       old.source_mime_type,old.verified_at
     ) then
    raise exception 'ready storage object bytes and provenance are immutable';
  end if;
  return new;
end
$$;
create trigger storage_object_guard before update or delete on storage_object
  for each row execute function mathpilot_storage_object_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- One actor -> student/thread projection, consumed by API and Storage RLS
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function mathpilot_science_v3_current_actor_students(
  p_tenant_id text,
  p_write boolean default false
) returns table (
  student_id text,
  user_id text,
  display_name text,
  actor_mode text,
  class_names text[],
  created_at timestamptz
)
language sql stable security definer set search_path=pg_catalog,public as $$
  select student.student_id,student.user_id,coalesce(identity.display_name,''),'self'::text,
         coalesce((
           select array_agg(distinct class.name order by class.name)
             from public.identity_class_user membership
             join public.identity_class class
               on class.tenant_id=membership.tenant_id and class.class_id=membership.class_id and class.status='active'
            where membership.tenant_id=student.tenant_id and membership.user_id=student.user_id
              and membership.class_role='student' and membership.status='active'
         ),'{}'::text[]),student.created_at
    from public.science_v3_student student
    join public.identity_user identity
      on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
   where p_tenant_id=current_setting('app.current_tenant',true)
     and student.tenant_id=p_tenant_id
     and student.user_id=current_setting('app.current_user',true)
     and (not p_write or exists (
       select 1 from public.identity_user_role role
        where role.tenant_id=p_tenant_id and role.user_id=student.user_id and role.role='student'
     ))
  union all
  select student.student_id,student.user_id,coalesce(identity.display_name,''),'teacher'::text,
         array_agg(distinct class.name order by class.name),student.created_at
    from public.science_v3_student student
    join public.identity_user identity
      on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
    join public.identity_class_user learner
      on learner.tenant_id=student.tenant_id and learner.user_id=student.user_id
     and learner.class_role='student' and learner.status='active'
    join public.identity_class_user teacher
      on teacher.tenant_id=learner.tenant_id and teacher.class_id=learner.class_id
     and teacher.user_id=current_setting('app.current_user',true)
     and teacher.class_role='teacher' and teacher.status='active'
    join public.identity_class class
      on class.tenant_id=learner.tenant_id and class.class_id=learner.class_id and class.status='active'
   where not p_write
     and p_tenant_id=current_setting('app.current_tenant',true)
     and student.tenant_id=p_tenant_id
     and student.user_id<>current_setting('app.current_user',true)
     and exists (
       select 1 from public.identity_user_role role
        where role.tenant_id=p_tenant_id
          and role.user_id=current_setting('app.current_user',true) and role.role='teacher'
     )
   group by student.student_id,student.user_id,identity.display_name,student.created_at
$$;

create or replace function mathpilot_science_v3_current_actor_thread(
  p_tenant_id text,
  p_conversation_thread_id text,
  p_write boolean default false
) returns table (
  student_id text,
  user_id text,
  display_name text,
  actor_mode text,
  thread_version bigint,
  thread_status text,
  thread_title text
)
language sql stable security definer set search_path=pg_catalog,public as $$
  select subject.student_id,subject.user_id,subject.display_name,subject.actor_mode,
         thread.version,thread.status,thread.title
    from public.science_v3_conversation_thread thread
    join public.mathpilot_science_v3_current_actor_students(p_tenant_id,p_write) subject
      on subject.student_id=thread.student_id
   where p_tenant_id=current_setting('app.current_tenant',true)
     and thread.tenant_id=p_tenant_id
     and thread.conversation_thread_id=p_conversation_thread_id
$$;

revoke all on function mathpilot_science_v3_current_actor_students(text,boolean) from public;
revoke all on function mathpilot_science_v3_current_actor_thread(text,text,boolean) from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- A single claim operation freezes every domain pointer to a ready descriptor
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function mathpilot_storage_claim_owned_object(
  p_tenant_id text,
  p_owner_user_id text,
  p_object_id text,
  p_purpose text,
  p_claim_kind text,
  p_claim_ref text
) returns table (
  object_id text,
  version_id text,
  sha256 text,
  byte_size bigint,
  mime_type text,
  original_name text,
  source_version_id text,
  source_sha256 text,
  source_byte_size bigint,
  source_mime_type text
)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_object public.storage_object%rowtype;
  v_retained boolean;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'storage object claim actor mismatch';
  end if;
  if p_claim_ref is null or length(p_claim_ref) not between 3 and 255 or not (
    (p_claim_kind='thread_attachment' and p_purpose='thread')
    or (p_claim_kind='avatar' and p_purpose='avatar')
    or (p_claim_kind in ('candidate_result','candidate_receipt') and p_purpose='candidate')
    or (p_claim_kind='content_source' and p_purpose in ('source','thread','derived'))
  ) then
    raise exception 'invalid storage object claim';
  end if;
  select object.* into v_object
    from public.storage_object object
   where object.tenant_id=p_tenant_id and object.owner_user_id=p_owner_user_id
     and object.object_id=p_object_id and object.purpose=p_purpose
   for update;
  if not found or v_object.state<>'ready' then
    raise exception 'storage object is unavailable';
  end if;
  select exists(
    select 1 from public.storage_object_claim claim
     where claim.tenant_id=p_tenant_id and claim.object_id=p_object_id
  ) into v_retained;
  if not v_retained and (v_object.expires_at is null or v_object.expires_at<=clock_timestamp()) then
    raise exception 'storage object is unavailable';
  end if;

  insert into public.storage_object_claim(
    tenant_id,object_id,claim_kind,claim_ref,version_id,sha256,byte_size,mime_type,
    original_name,source_version_id,source_sha256,source_byte_size,source_mime_type
  ) values (
    p_tenant_id,p_object_id,p_claim_kind,p_claim_ref,v_object.version_id,v_object.sha256,
    v_object.byte_size,v_object.mime_type,v_object.original_name,v_object.source_version_id,
    v_object.source_sha256,v_object.source_byte_size,v_object.source_mime_type
  ) on conflict on constraint storage_object_claim_pkey do nothing;
  update public.storage_object object set expires_at=null
   where object.tenant_id=p_tenant_id and object.object_id=p_object_id;

  return query
    select claim.object_id,claim.version_id,claim.sha256,claim.byte_size,claim.mime_type,
           claim.original_name,claim.source_version_id,claim.source_sha256,
           claim.source_byte_size,claim.source_mime_type
      from public.storage_object_claim claim
     where claim.tenant_id=p_tenant_id and claim.object_id=p_object_id
       and claim.claim_kind=p_claim_kind and claim.claim_ref=p_claim_ref;
end
$$;
revoke all on function mathpilot_storage_claim_owned_object(text,text,text,text,text,text) from public;

create or replace function mathpilot_storage_release_owned_claim(
  p_tenant_id text,
  p_owner_user_id text,
  p_object_id text,
  p_claim_kind text,
  p_claim_ref text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_released boolean;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true)
     or p_claim_ref is null or length(p_claim_ref) not between 3 and 255 then
    raise exception 'storage object release actor mismatch';
  end if;
  perform 1 from public.storage_object object
   where object.tenant_id=p_tenant_id and object.owner_user_id=p_owner_user_id
     and object.object_id=p_object_id
   for update;
  if not found then return false; end if;
  with released as (
    delete from public.storage_object_claim claim
     where claim.tenant_id=p_tenant_id and claim.object_id=p_object_id
       and claim.claim_kind=p_claim_kind and claim.claim_ref=p_claim_ref
    returning true
  ) select coalesce((select true from released),false) into v_released;
  if v_released and not exists(
    select 1 from public.storage_object_claim claim
     where claim.tenant_id=p_tenant_id and claim.object_id=p_object_id
  ) then
    update public.storage_object object
       set state='deleting',deletion_lease_id=null,deletion_started_at=null,
           expires_at=clock_timestamp()+interval '10 minutes'
     where object.tenant_id=p_tenant_id and object.object_id=p_object_id and object.state='ready';
  end if;
  return v_released;
end
$$;
revoke all on function mathpilot_storage_release_owned_claim(text,text,text,text,text) from public;

create or replace function mathpilot_storage_request_owned_deletion(
  p_tenant_id text,
  p_owner_user_id text,
  p_object_id text,
  p_allowed_purposes text[]
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_object public.storage_object%rowtype;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true)
     or coalesce(cardinality(p_allowed_purposes),0) not between 1 and 6
     or not (p_allowed_purposes <@ array['source','candidate','package','thread','avatar','derived']::text[]) then
    raise exception 'invalid storage object deletion request';
  end if;
  select object.* into v_object
    from public.storage_object object
   where object.tenant_id=p_tenant_id and object.owner_user_id=p_owner_user_id
     and object.object_id=p_object_id
   for update;
  if not found or not (v_object.purpose=any(p_allowed_purposes))
     or v_object.state not in ('pending','ready','failed')
     or exists (
       select 1 from public.storage_object_claim claim
        where claim.tenant_id=p_tenant_id and claim.object_id=p_object_id
     ) then
    return false;
  end if;
  update public.storage_object object
     set state='deleting',verification_lease_id=null,verification_started_at=null,
         deletion_lease_id=null,deletion_started_at=null,expires_at=clock_timestamp(),
         last_failure_code=null
   where object.tenant_id=p_tenant_id and object.object_id=p_object_id;
  return true;
end
$$;
revoke all on function mathpilot_storage_request_owned_deletion(text,text,text,text[]) from public;

-- Domain adapters expose only the claim vocabulary each caller owns. The
-- generic primitive remains private to security-definer functions.
create or replace function mathpilot_content_claim_candidate_audit_object(
  p_tenant_id text,
  p_owner_user_id text,
  p_object_id text,
  p_audit_role text,
  p_candidate_set_id text
) returns table (
  object_id text,version_id text,sha256 text,byte_size bigint,mime_type text,
  original_name text,source_version_id text,source_sha256 text,
  source_byte_size bigint,source_mime_type text
)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_audit_role is null or p_audit_role not in ('result','receipt')
     or p_candidate_set_id is null or p_candidate_set_id !~ '^cset_[A-Za-z0-9]{8,}$'
     or not exists (
       select 1 from public.identity_user_role role
        where role.tenant_id=p_tenant_id and role.user_id=p_owner_user_id and role.role='teacher'
     ) then
    raise exception 'invalid content candidate audit claim';
  end if;
  return query select * from public.mathpilot_storage_claim_owned_object(
    p_tenant_id,p_owner_user_id,p_object_id,'candidate',
    case p_audit_role when 'result' then 'candidate_result' else 'candidate_receipt' end,
    'candidate-set:'||p_candidate_set_id
  );
end
$$;
revoke all on function mathpilot_content_claim_candidate_audit_object(text,text,text,text,text) from public;

-- Candidate audit retention is part of the row contract.  A caller with the
-- application role cannot create a candidate that merely points at expiring
-- objects, even if it bypasses the Content TypeScript repository.
create or replace function mathpilot_content_claim_candidate_audit_objects() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_result record;
  v_receipt record;
begin
  if TG_RELID<>'public.content_candidate_set'::regclass
     or TG_OP<>'INSERT' or TG_WHEN<>'BEFORE' or TG_LEVEL<>'ROW' then
    raise exception 'invalid candidate audit trigger context';
  end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true)
     or new.owner_teacher_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'candidate audit actor mismatch';
  end if;

  select * into strict v_result
    from public.mathpilot_content_claim_candidate_audit_object(
      new.tenant_id,new.owner_teacher_user_id,new.result_object_id,'result',new.candidate_set_id
    );
  select * into strict v_receipt
    from public.mathpilot_content_claim_candidate_audit_object(
      new.tenant_id,new.owner_teacher_user_id,new.receipt_object_id,'receipt',new.candidate_set_id
    );
  if v_result.mime_type<>'application/json' or v_receipt.mime_type<>'application/json'
     or v_result.sha256<>new.result_sha256 then
    raise exception 'candidate audit objects do not match the immutable result contract';
  end if;
  return new;
end
$$;
revoke all on function mathpilot_content_claim_candidate_audit_objects() from public;
create trigger content_candidate_set_claim_audit_objects
  before insert on content_candidate_set
  for each row execute function mathpilot_content_claim_candidate_audit_objects();

-- Candidate identity and audit artifacts never change after registration.
-- Review owns only the explicit status transitions and decided_at timestamp.
create or replace function mathpilot_candidate_set_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare
  input_phase text;
  input_status text;
begin
  if TG_RELID<>'public.content_candidate_set'::regclass
     or TG_OP not in ('INSERT','UPDATE') or TG_LEVEL<>'ROW' then
    raise exception 'invalid candidate set trigger context';
  end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true)
     or new.owner_teacher_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'candidate set actor mismatch';
  end if;
  if TG_OP='UPDATE' then
    if row(new.candidate_set_id,new.tenant_id,new.phase,new.owner_teacher_user_id,
           new.thread_id,new.sequence_no,new.input_candidate_set_id,
           new.supersedes_candidate_set_id,new.result_object_id,new.receipt_object_id,
           new.result_sha256,new.respond_tool_call_id,new.created_at)
       is distinct from
       row(old.candidate_set_id,old.tenant_id,old.phase,old.owner_teacher_user_id,
           old.thread_id,old.sequence_no,old.input_candidate_set_id,
           old.supersedes_candidate_set_id,old.result_object_id,old.receipt_object_id,
           old.result_sha256,old.respond_tool_call_id,old.created_at) then
      raise exception 'candidate set identity and audit artifacts are immutable';
    end if;
    if not (
      (old.status='pending_review' and new.status in ('approved','changes_requested')
        and old.decided_at is null and new.decided_at is not null
        and exists (
          select 1 from public.content_review_decision decision
           where decision.tenant_id=new.tenant_id
             and decision.candidate_set_id=new.candidate_set_id
             and decision.decision=new.status
             and decision.decided_by_user_id=new.owner_teacher_user_id
        ))
      or (old.status='changes_requested' and new.status='superseded'
        and old.decided_at is not null and new.decided_at is not distinct from old.decided_at
        and exists (
          select 1 from public.content_candidate_set replacement
           where replacement.tenant_id=new.tenant_id
             and replacement.owner_teacher_user_id=new.owner_teacher_user_id
             and replacement.supersedes_candidate_set_id=new.candidate_set_id
        ))
    ) then
      raise exception 'invalid candidate set status transition % -> %',old.status,new.status;
    end if;
  elsif new.status<>'pending_review' or new.decided_at is not null then
    raise exception 'candidate set must begin pending review';
  end if;
  if new.phase='ktq' and new.input_candidate_set_id is not null then
    raise exception 'KTQ candidate cannot have an input candidate set';
  end if;
  if new.phase='er' then
    if new.input_candidate_set_id is null then
      raise exception 'ER candidate requires an approved KTQ input';
    end if;
    select candidate.phase,candidate.status into input_phase,input_status
      from public.content_candidate_set candidate
     where candidate.candidate_set_id=new.input_candidate_set_id;
    if input_phase is distinct from 'ktq' or input_status is distinct from 'approved' then
      raise exception 'ER input must be an approved KTQ candidate';
    end if;
  end if;
  if new.supersedes_candidate_set_id is not null and not exists (
    select 1 from public.content_candidate_set previous
     where previous.candidate_set_id=new.supersedes_candidate_set_id
       and previous.tenant_id=new.tenant_id and previous.thread_id=new.thread_id
       and previous.phase=new.phase
       and previous.owner_teacher_user_id=new.owner_teacher_user_id
       and previous.status='changes_requested'
  ) then
    raise exception 'superseded candidate must be the same thread/phase and marked changes_requested';
  end if;
  return new;
end
$$;

-- A canonical Content source that points at bytes owns a permanent claim.
-- URI-only official manifest sources remain valid and create no fake object
-- capability.
create or replace function mathpilot_content_claim_source_reference() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_purpose text;
  v_descriptor record;
begin
  if TG_RELID<>'public.content_source'::regclass
     or TG_OP<>'INSERT' or TG_WHEN<>'BEFORE' or TG_LEVEL<>'ROW' then
    raise exception 'invalid content source trigger context';
  end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true)
     or new.original_sha256 is null then
    raise exception 'content source actor mismatch';
  end if;
  -- All source producers share this lock, so canonicalization by original digest
  -- is deterministic even when official import and teacher ingestion overlap.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.tenant_id||E'\x1f'||new.original_sha256,0)
  );
  if new.storage_object_id is null then return new; end if;
  if new.owner_teacher_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'content source actor mismatch';
  end if;
  select object.purpose into v_purpose
    from public.storage_object object
   where object.tenant_id=new.tenant_id and object.owner_user_id=new.owner_teacher_user_id
     and object.object_id=new.storage_object_id and object.purpose in ('source','thread','derived');
  if v_purpose is null then raise exception 'content source object is unavailable'; end if;
  select * into strict v_descriptor
    from public.mathpilot_storage_claim_owned_object(
      new.tenant_id,new.owner_teacher_user_id,new.storage_object_id,v_purpose,
      'content_source','source:'||new.source_id
    );
  if v_descriptor.source_sha256<>new.original_sha256 then
    raise exception 'content source digest does not match the immutable source bytes';
  end if;
  new.verified_at:=coalesce(new.verified_at,clock_timestamp());
  return new;
end
$$;
revoke all on function mathpilot_content_claim_source_reference() from public;
create trigger content_source_claim_object
  before insert on content_source
  for each row execute function mathpilot_content_claim_source_reference();

-- Earlier candidate rows do not contain the exact input manifest required by
-- the final architecture.  Refuse an ambiguous incremental cutover instead of
-- inventing paths or silently keeping a compatibility branch.
do $$
begin
  if exists (select 1 from content_candidate_set) then
    raise exception 'pre-integrity candidate sets require a clean Next content cutover';
  end if;
  if exists (select 1 from content_source where storage_object_id is not null)
     or exists (select 1 from content_source_page where page_object_id is not null)
     or exists (select 1 from content_package where manifest_object_id is not null) then
    raise exception 'pre-integrity content object pointers require a clean Next content cutover';
  end if;
end
$$;

-- Every retained domain pointer carries tenant identity in its foreign key.
-- RLS on the referencing table alone cannot prove that an object belongs to
-- the same tenant.
alter table content_candidate_set
  drop constraint if exists content_candidate_set_result_object_id_fkey,
  drop constraint if exists content_candidate_set_receipt_object_id_fkey,
  add constraint content_candidate_set_tenant_candidate_unique unique(tenant_id,candidate_set_id),
  add constraint content_candidate_set_result_object_tenant_fk
    foreign key(tenant_id,result_object_id) references storage_object(tenant_id,object_id),
  add constraint content_candidate_set_receipt_object_tenant_fk
    foreign key(tenant_id,receipt_object_id) references storage_object(tenant_id,object_id);
alter table content_source
  drop constraint if exists content_source_storage_object_id_fkey,
  add constraint content_source_tenant_source_unique unique(tenant_id,source_id),
  add constraint content_source_storage_object_tenant_fk
    foreign key(tenant_id,storage_object_id) references storage_object(tenant_id,object_id);
alter table content_source_page
  drop constraint if exists content_source_page_page_object_id_fkey,
  add constraint content_source_page_object_tenant_fk
    foreign key(tenant_id,page_object_id) references storage_object(tenant_id,object_id);
alter table content_question_asset_revision
  drop constraint if exists content_question_asset_revision_storage_object_id_fkey,
  add constraint content_question_asset_object_tenant_fk
    foreign key(tenant_id,storage_object_id) references storage_object(tenant_id,object_id);
alter table content_field_provenance
  drop constraint if exists content_field_provenance_source_object_id_fkey,
  add constraint content_field_provenance_object_tenant_fk
    foreign key(tenant_id,source_object_id) references storage_object(tenant_id,object_id);
alter table content_package
  drop constraint if exists content_package_manifest_object_id_fkey,
  add constraint content_package_manifest_object_tenant_fk
    foreign key(tenant_id,manifest_object_id) references storage_object(tenant_id,object_id);

create table content_candidate_source_object (
  tenant_id          text not null references identity_tenant(tenant_id),
  candidate_set_id   text not null,
  source_id          text not null,
  workspace_path     text not null check (
    workspace_path ~ '^input/original/[^/\\\x00]+$'
  ),
  object_id          text not null,
  version_id         text not null,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size          bigint not null check (byte_size between 1 and 50331648),
  mime_type          text not null,
  original_name      text not null,
  source_version_id  text not null,
  source_sha256      text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size   bigint not null check (source_byte_size between 1 and 50331648),
  source_mime_type   text not null,
  created_at         timestamptz not null default clock_timestamp(),
  primary key(tenant_id,candidate_set_id,workspace_path),
  unique(tenant_id,candidate_set_id,object_id),
  foreign key(tenant_id,candidate_set_id)
    references content_candidate_set(tenant_id,candidate_set_id),
  foreign key(tenant_id,object_id) references storage_object(tenant_id,object_id),
  foreign key(tenant_id,source_id) references content_source(tenant_id,source_id)
);
create table content_candidate_source_seal (
  tenant_id        text not null,
  candidate_set_id text not null,
  source_count     integer not null check (source_count between 1 and 64),
  sealed_at        timestamptz not null default clock_timestamp(),
  primary key(tenant_id,candidate_set_id),
  foreign key(tenant_id,candidate_set_id)
    references content_candidate_set(tenant_id,candidate_set_id)
);

-- This is the only application-callable candidate-source binder.  It owns the
-- claim, canonical source link, frozen descriptor and row insert in one DB
-- operation; callers provide only the requested immutable identity.
create or replace function mathpilot_content_bind_candidate_source_object(
  p_tenant_id text,
  p_owner_user_id text,
  p_candidate_set_id text,
  p_workspace_path text,
  p_object_id text,
  p_version_id text,
  p_sha256 text
) returns table (
  object_id text,version_id text,sha256 text,byte_size bigint,mime_type text,
  original_name text,source_version_id text,source_sha256 text,
  source_byte_size bigint,source_mime_type text
)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_purpose text;
  v_source_sha256 text;
  v_descriptor record;
  v_source_id text;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true)
     or p_candidate_set_id is null or p_candidate_set_id !~ '^cset_[A-Za-z0-9]{8,}$'
     or p_workspace_path is null or p_workspace_path !~ '^input/original/[^/\\\x00]+$'
     or not exists (
       select 1 from public.content_candidate_set candidate
        where candidate.tenant_id=p_tenant_id and candidate.candidate_set_id=p_candidate_set_id
          and candidate.owner_teacher_user_id=p_owner_user_id
     ) then
    raise exception 'invalid content candidate source binding';
  end if;
  perform 1 from public.content_candidate_set candidate
   where candidate.tenant_id=p_tenant_id and candidate.candidate_set_id=p_candidate_set_id
   for update;
  if exists (
    select 1 from public.content_candidate_source_seal seal
     where seal.tenant_id=p_tenant_id and seal.candidate_set_id=p_candidate_set_id
  ) then
    raise exception 'candidate source manifest is sealed';
  end if;
  select object.purpose,object.source_sha256 into v_purpose,v_source_sha256
    from public.storage_object object
   where object.tenant_id=p_tenant_id and object.owner_user_id=p_owner_user_id
     and object.object_id=p_object_id and object.purpose in ('source','thread','derived');
  if v_purpose is null then raise exception 'content source object is unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id||E'\x1f'||v_source_sha256,0)
  );
  select * into strict v_descriptor
    from public.mathpilot_storage_claim_owned_object(
      p_tenant_id,p_owner_user_id,p_object_id,v_purpose,
      'content_source','candidate-set:'||p_candidate_set_id
    );
  if p_version_id is distinct from v_descriptor.version_id
     or p_sha256 is distinct from v_descriptor.sha256 then
    raise exception 'candidate source descriptor does not match immutable object bytes';
  end if;

  select source.source_id into v_source_id
    from public.content_source source
   where source.tenant_id=p_tenant_id and source.original_sha256=v_descriptor.source_sha256;
  if v_source_id is null then
    v_source_id:='src_'||substring(p_object_id from 5);
    insert into public.content_source(
      source_id,tenant_id,origin,owner_teacher_user_id,uploaded_by_user_id,source_kind,
      original_sha256,storage_object_id,source_uri,verified_at
    ) values (
      v_source_id,p_tenant_id,'teacher',p_owner_user_id,p_owner_user_id,
      'uploaded-object',v_descriptor.source_sha256,p_object_id,null,clock_timestamp()
    );
  end if;

  insert into public.content_candidate_source_object(
    tenant_id,candidate_set_id,source_id,workspace_path,object_id,version_id,sha256,byte_size,
    mime_type,original_name,source_version_id,source_sha256,source_byte_size,source_mime_type
  ) values (
    p_tenant_id,p_candidate_set_id,v_source_id,p_workspace_path,p_object_id,
    v_descriptor.version_id,v_descriptor.sha256,v_descriptor.byte_size,v_descriptor.mime_type,
    v_descriptor.original_name,v_descriptor.source_version_id,v_descriptor.source_sha256,
    v_descriptor.source_byte_size,v_descriptor.source_mime_type
  );
  return query select v_descriptor.object_id,v_descriptor.version_id,v_descriptor.sha256,
    v_descriptor.byte_size,v_descriptor.mime_type,v_descriptor.original_name,
    v_descriptor.source_version_id,v_descriptor.source_sha256,
    v_descriptor.source_byte_size,v_descriptor.source_mime_type;
end
$$;
revoke all on function mathpilot_content_bind_candidate_source_object(text,text,text,text,text,text,text) from public;

create or replace function mathpilot_content_require_candidate_sources() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  if TG_RELID<>'public.content_candidate_set'::regclass
     or TG_OP<>'INSERT' or TG_WHEN<>'AFTER' or TG_LEVEL<>'ROW' then
    raise exception 'invalid candidate source seal trigger context';
  end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true)
     or new.owner_teacher_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'candidate source seal actor mismatch';
  end if;
  select count(*) into v_count from public.content_candidate_source_object source
   where source.tenant_id=new.tenant_id and source.candidate_set_id=new.candidate_set_id;
  if v_count not between 1 and 64 then
    raise exception 'candidate set requires 1 to 64 frozen source objects';
  end if;
  insert into public.content_candidate_source_seal(tenant_id,candidate_set_id,source_count)
  values(new.tenant_id,new.candidate_set_id,v_count)
  on conflict(tenant_id,candidate_set_id) do update set source_count=excluded.source_count
  where content_candidate_source_seal.source_count=excluded.source_count;
  if not found then raise exception 'candidate source manifest changed after sealing'; end if;
  return null;
end
$$;
revoke all on function mathpilot_content_require_candidate_sources() from public;
create constraint trigger content_candidate_set_requires_sources
  after insert on content_candidate_set deferrable initially deferred
  for each row execute function mathpilot_content_require_candidate_sources();

alter table content_candidate_source_object enable row level security;
alter table content_candidate_source_object force row level security;
create policy content_candidate_source_object_owner on content_candidate_source_object
  for select using (
    tenant_id=current_setting('app.current_tenant',true)
    and exists (
      select 1 from content_candidate_set candidate
       where candidate.tenant_id=content_candidate_source_object.tenant_id
         and candidate.candidate_set_id=content_candidate_source_object.candidate_set_id
         and candidate.owner_teacher_user_id=current_setting('app.current_user',true)
    )
  );

-- Asset and provenance rows are projections of a candidate's already-frozen
-- source set.  They do not create a second retention protocol; the database
-- enforces that they can only point at that set and that byte metadata remains
-- exact.
create or replace function mathpilot_content_validate_candidate_object_projection() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_source public.content_candidate_source_object%rowtype;
begin
  if TG_RELID not in (
       'public.content_question_asset_revision'::regclass,
       'public.content_field_provenance'::regclass
     ) or TG_OP<>'INSERT' or TG_WHEN<>'BEFORE' or TG_LEVEL<>'ROW' then
    raise exception 'invalid content object projection trigger context';
  end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true) then
    raise exception 'content object projection tenant mismatch';
  end if;
  if tg_table_name='content_question_asset_revision' then
    select source.* into v_source
      from public.content_revision_item item
      join public.content_entity_revision revision
        on revision.tenant_id=item.tenant_id and revision.revision_id=item.revision_id
      join public.content_candidate_set candidate
        on candidate.tenant_id=revision.tenant_id
       and candidate.candidate_set_id=revision.candidate_set_id
      left join public.content_candidate_source_object source
        on source.tenant_id=revision.tenant_id
       and source.candidate_set_id=revision.candidate_set_id
       and source.object_id=new.storage_object_id
     where item.tenant_id=new.tenant_id and item.item_id=new.item_id
       and candidate.owner_teacher_user_id=current_setting('app.current_user',true);
    if not found then
      raise exception 'question asset candidate owner mismatch';
    end if;
    if new.storage_object_id is null then return new; end if;
    if v_source.object_id is null
       or new.content_sha256 is distinct from v_source.sha256
       or new.mime_type is distinct from v_source.mime_type
       or new.source_locator is distinct from v_source.workspace_path then
      raise exception 'question asset is not an exact candidate source projection';
    end if;
  elsif tg_table_name='content_field_provenance' then
    select source.* into v_source
      from public.content_entity_revision revision
      join public.content_candidate_set candidate
        on candidate.tenant_id=revision.tenant_id
       and candidate.candidate_set_id=revision.candidate_set_id
      left join public.content_candidate_source_object source
        on source.tenant_id=revision.tenant_id
       and source.candidate_set_id=revision.candidate_set_id
       and source.object_id=new.source_object_id
     where revision.tenant_id=new.tenant_id and revision.revision_id=new.revision_id
       and candidate.owner_teacher_user_id=current_setting('app.current_user',true);
    if not found then
      raise exception 'field provenance candidate owner mismatch';
    end if;
    if new.source_object_id is null then return new; end if;
    if v_source.object_id is null then
      raise exception 'field provenance object is outside its candidate source set';
    end if;
  else
    raise exception 'unsupported content object projection table';
  end if;
  return new;
end
$$;
revoke all on function mathpilot_content_validate_candidate_object_projection() from public;
create trigger content_question_asset_validate_object
  before insert on content_question_asset_revision
  for each row execute function mathpilot_content_validate_candidate_object_projection();
create trigger content_field_provenance_validate_object
  before insert on content_field_provenance
  for each row execute function mathpilot_content_validate_candidate_object_projection();

create or replace function mathpilot_content_field_provenance_guard() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if TG_RELID<>'public.content_field_provenance'::regclass
     or TG_OP not in ('UPDATE','DELETE') or TG_LEVEL<>'ROW' then
    raise exception 'invalid field provenance trigger context';
  end if;
  if TG_OP='DELETE' then raise exception 'field provenance is immutable'; end if;
  if new.tenant_id is distinct from current_setting('app.current_tenant',true) then
    raise exception 'field provenance actor mismatch';
  end if;
  if row(new.provenance_id,new.tenant_id,new.revision_id,new.revision_item_id,
         new.field_name,new.source_excerpt_id,new.source_object_id,new.thread_id,
         new.tool_call_id,new.source_locator,new.derivation_type,new.provenance_status,
         new.created_at)
     is distinct from
     row(old.provenance_id,old.tenant_id,old.revision_id,old.revision_item_id,
         old.field_name,old.source_excerpt_id,old.source_object_id,old.thread_id,
         old.tool_call_id,old.source_locator,old.derivation_type,old.provenance_status,
         old.created_at) then
    raise exception 'field provenance identity and source are immutable';
  end if;
  if old.review_decision is distinct from 'pending'
     or new.review_decision not in ('confirmed','modified')
     or not exists (
       select 1 from public.content_entity_revision revision
       join public.content_candidate_set candidate
         on candidate.tenant_id=revision.tenant_id
        and candidate.candidate_set_id=revision.candidate_set_id
        and candidate.owner_teacher_user_id=current_setting('app.current_user',true)
        and candidate.status=case new.review_decision
          when 'confirmed' then 'approved' else 'changes_requested' end
       where revision.tenant_id=new.tenant_id and revision.revision_id=new.revision_id
     ) then
    raise exception 'invalid field provenance review transition';
  end if;
  return new;
end
$$;
create trigger content_field_provenance_guard
  before update or delete on content_field_provenance
  for each row execute function mathpilot_content_field_provenance_guard();

-- Storage owns expiry and physical deletion.  The application role can only
-- lease bounded batches through these security-definer functions; it never
-- receives a cross-tenant table policy or a reusable "system principal".
create or replace function mathpilot_storage_begin_deletions(
  p_lease_id text,
  p_limit integer default 32
) returns table (
  object_id text,
  bucket_name text,
  source_object_key text,
  source_version_id text,
  object_key text,
  version_id text,
  deletion_attempts integer
)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_lease_id is null
     or p_lease_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid storage deletion lease';
  end if;

  -- Expiry is a lifecycle transition, not a second policy in the worker.
  with expired as (
    select object.object_id
      from public.storage_object object
     where object.expires_at<=clock_timestamp()
       and not exists (
         select 1 from public.storage_object_claim claim
          where claim.tenant_id=object.tenant_id and claim.object_id=object.object_id
       )
       and (
         object.state in ('pending','ready','failed')
         or (object.state='verifying'
             and object.verification_started_at<clock_timestamp()-interval '15 minutes')
       )
     order by object.expires_at,object.created_at,object.object_id
     for update of object skip locked
     limit p_limit
  )
  update public.storage_object object
     set state='deleting',verification_lease_id=null,verification_started_at=null,deletion_lease_id=null,
         deletion_started_at=null,expires_at=clock_timestamp()
    from expired
   where object.object_id=expired.object_id;

  return query
    with candidates as (
      select object.object_id
       from public.storage_object object
       where object.state='deleting' and object.expires_at<=clock_timestamp()
         and not exists (
           select 1 from public.storage_object_claim claim
            where claim.tenant_id=object.tenant_id and claim.object_id=object.object_id
         )
         and (object.deletion_lease_id is null
           or object.deletion_started_at<clock_timestamp()-interval '15 minutes')
       order by object.expires_at,object.created_at,object.object_id
       for update skip locked
       limit p_limit
    )
    update public.storage_object object
       set deletion_lease_id=p_lease_id,deletion_started_at=clock_timestamp(),
           deletion_attempts=object.deletion_attempts+1
      from candidates
     where object.object_id=candidates.object_id
    returning object.object_id,object.bucket_name,object.source_object_key,
              object.source_version_id,object.object_key,object.version_id,
              object.deletion_attempts;
end
$$;

create or replace function mathpilot_storage_finish_deletion(
  p_lease_id text,
  p_object_id text
) returns boolean
language sql security definer set search_path=pg_catalog,public as $$
  with finished as (
    update public.storage_object object
       set state='deleted',deletion_lease_id=null,deletion_started_at=null,deleted_at=clock_timestamp(),
           expires_at=null,last_failure_code=null,last_failure_at=null
     where object.object_id=p_object_id and object.state='deleting'
       and object.deletion_lease_id=p_lease_id
    returning true
  ) select coalesce((select true from finished),false)
$$;

create or replace function mathpilot_storage_retry_deletion(
  p_lease_id text,
  p_object_id text,
  p_failure_code text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_updated boolean;
begin
  if p_failure_code is null or p_failure_code !~ '^[a-z0-9_]{3,64}$' then
    raise exception 'invalid storage deletion failure code';
  end if;
  with retried as (
    update public.storage_object object
       set deletion_lease_id=null,deletion_started_at=null,
           expires_at=clock_timestamp()
             + make_interval(secs=>least(3600,greatest(5,5*(2^least(object.deletion_attempts,9))))::integer),
           last_failure_code=p_failure_code,last_failure_at=clock_timestamp()
     where object.object_id=p_object_id and object.state='deleting'
       and object.deletion_lease_id=p_lease_id
    returning true
  ) select coalesce((select true from retried),false) into v_updated;
  return v_updated;
end
$$;

revoke all on function mathpilot_storage_begin_deletions(text,integer) from public;
revoke all on function mathpilot_storage_finish_deletion(text,text) from public;
revoke all on function mathpilot_storage_retry_deletion(text,text,text) from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical message attachment binding and atomic descriptor validation
-- ─────────────────────────────────────────────────────────────────────────────
create table science_v3_message_attachment (
  tenant_id              text not null references identity_tenant(tenant_id),
  conversation_thread_id text not null,
  message_id              text not null,
  part_index              integer not null check (part_index between 0 and 1023),
  object_id               text not null check (object_id ~ '^obj_[A-Za-z0-9]{8,}$'),
  version_id              text not null,
  sha256                  text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size               bigint not null check (byte_size>0),
  mime_type               text not null,
  original_name           text not null,
  source_version_id       text not null,
  source_sha256           text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size        bigint not null check (source_byte_size>0),
  source_mime_type        text not null,
  created_at              timestamptz not null default now(),
  primary key (tenant_id,message_id,part_index),
  unique (tenant_id,message_id,object_id),
  foreign key (tenant_id,conversation_thread_id)
    references science_v3_conversation_thread(tenant_id,conversation_thread_id),
  foreign key (tenant_id,message_id)
    references science_v3_canonical_message(tenant_id,message_id),
  foreign key (tenant_id,object_id)
    references storage_object(tenant_id,object_id)
);
create index science_v3_message_attachment_object_idx
  on science_v3_message_attachment(tenant_id,object_id,conversation_thread_id);

-- Strictly upgrade current Next messages. No runtime compatibility branch is
-- retained for the earlier four-field attachment part.
do $$
begin
  if exists (
    select 1
      from science_v3_canonical_message message
      join science_v3_conversation_thread thread
        on thread.tenant_id=message.tenant_id and thread.conversation_thread_id=message.conversation_thread_id
      join science_v3_student student
        on student.tenant_id=thread.tenant_id and student.student_id=thread.student_id
      cross join lateral jsonb_array_elements(message.parts) part
      left join storage_object object
        on object.tenant_id=message.tenant_id
       and object.object_id=substring(part->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
     where part->>'type'='attachment' and (
       message.author_kind<>'student' or message.author_user_id<>student.user_id
       or object.object_id is null or object.owner_user_id<>student.user_id
       or object.purpose<>'thread' or object.state<>'ready'
       or object.version_id is null or object.sha256 is null or object.byte_size is null
       or object.source_version_id is null or object.source_sha256 is null
       or object.mime_type not in (
         'application/json','text/plain','text/markdown','text/csv',
         'image/jpeg','image/png','image/webp','image/gif','image/bmp'
       )
       or object.mime_type<>part->>'mime_type' or coalesce(object.original_name,'')<>part->>'name'
       or object.expires_at<=clock_timestamp()
       or (part ? 'version_id' and part->>'version_id'<>object.version_id)
       or (part ? 'sha256' and part->>'sha256'<>object.sha256)
       or (part ? 'byte_size' and part->>'byte_size'<>object.byte_size::text)
     )
  ) then
    raise exception 'cannot bind an invalid existing Science-v3 attachment';
  end if;
  if exists (
    select 1
      from science_v3_canonical_message message
      cross join lateral jsonb_array_elements(message.parts) part
     where part->>'type'='attachment'
     group by substring(part->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
    having count(distinct message.message_id)>1
  ) then
    raise exception 'a thread object cannot be bound to multiple canonical messages';
  end if;
  if exists (
    select 1
      from science_v3_canonical_message message
      cross join lateral jsonb_array_elements(message.parts) part
      join storage_object object
        on object.tenant_id=message.tenant_id
       and object.object_id=substring(part->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
     where part->>'type'='attachment'
     group by message.tenant_id,message.message_id
    having sum(object.byte_size)>50331648
  ) then
    raise exception 'existing Science-v3 message attachments exceed 48 MiB';
  end if;
end
$$;

alter table science_v3_canonical_message disable trigger science_v3_canonical_message_guard;
alter table science_v3_canonical_message disable trigger science_v3_canonical_message_client_event;
with upgraded as (
  select message.tenant_id,message.message_id,
         jsonb_agg(
           case when part.value->>'type'='attachment' then
             part.value || jsonb_build_object(
               'version_id',object.version_id,'sha256',object.sha256,'byte_size',object.byte_size
             )
           else part.value end order by part.ordinality
         ) as parts
    from science_v3_canonical_message message
    cross join lateral jsonb_array_elements(message.parts) with ordinality part(value,ordinality)
    left join storage_object object
      on object.tenant_id=message.tenant_id
     and object.object_id=substring(part.value->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
   group by message.tenant_id,message.message_id
  having bool_or(part.value->>'type'='attachment')
)
update science_v3_canonical_message message
   set parts=upgraded.parts
  from upgraded
 where message.tenant_id=upgraded.tenant_id and message.message_id=upgraded.message_id;
alter table science_v3_canonical_message enable trigger science_v3_canonical_message_client_event;
alter table science_v3_canonical_message enable trigger science_v3_canonical_message_guard;

with bound as (
  select distinct message.tenant_id,message.message_id,object.object_id,
         object.version_id,object.sha256,object.byte_size,object.mime_type,
         object.original_name,object.source_version_id,object.source_sha256,
         object.source_byte_size,object.source_mime_type
    from science_v3_canonical_message message
    cross join lateral jsonb_array_elements(message.parts) part
    join storage_object object
      on object.tenant_id=message.tenant_id
     and object.object_id=substring(part->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
   where part->>'type'='attachment'
)
insert into storage_object_claim(
  tenant_id,object_id,claim_kind,claim_ref,version_id,sha256,byte_size,mime_type,
  original_name,source_version_id,source_sha256,source_byte_size,source_mime_type
)
select tenant_id,object_id,'thread_attachment','message:'||message_id,
       version_id,sha256,byte_size,mime_type,original_name,
       source_version_id,source_sha256,source_byte_size,source_mime_type
  from bound;
update storage_object object set expires_at=null
 where exists (
   select 1 from storage_object_claim claim
    where claim.tenant_id=object.tenant_id and claim.object_id=object.object_id
 );

insert into science_v3_message_attachment(
  tenant_id,conversation_thread_id,message_id,part_index,object_id,
  version_id,sha256,byte_size,mime_type,original_name,
  source_version_id,source_sha256,source_byte_size,source_mime_type,created_at
)
select message.tenant_id,message.conversation_thread_id,message.message_id,part.ordinality::integer-1,
       object.object_id,object.version_id,object.sha256,object.byte_size,object.mime_type,
       object.original_name,object.source_version_id,object.source_sha256,
       object.source_byte_size,object.source_mime_type,message.created_at
  from science_v3_canonical_message message
  cross join lateral jsonb_array_elements(message.parts) with ordinality part(value,ordinality)
  join storage_object object
    on object.tenant_id=message.tenant_id
   and object.object_id=substring(part.value->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
 where part.value->>'type'='attachment';

create or replace function mathpilot_science_v3_claim_message_attachments() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_part jsonb;
  v_index bigint;
  v_object_id text;
  v_descriptor record;
  v_total_bytes bigint:=0;
begin
  if TG_RELID<>'public.science_v3_canonical_message'::regclass
     or TG_OP not in ('INSERT','UPDATE') or TG_WHEN<>'BEFORE' or TG_LEVEL<>'ROW' then
    raise exception 'invalid message attachment claim trigger context';
  end if;
  if TG_OP='UPDATE' and new.parts is not distinct from old.parts then
    return new;
  end if;
  if not exists (select 1 from jsonb_array_elements(new.parts) part where part->>'type'='attachment') then
    return new;
  end if;
  if new.author_kind<>'student' or new.lifecycle<>'committed'
     or new.tenant_id is distinct from current_setting('app.current_tenant',true)
     or new.author_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'attachments require a committed message from the current student';
  end if;
  if not exists (
    select 1 from public.science_v3_conversation_thread thread
    join public.science_v3_student student
      on student.tenant_id=thread.tenant_id and student.student_id=thread.student_id
    where thread.tenant_id=new.tenant_id and thread.conversation_thread_id=new.conversation_thread_id
      and student.user_id=new.author_user_id
  ) then
    raise exception 'attachment author does not own the conversation thread';
  end if;
  for v_part,v_index in
    select part.value,part.ordinality
      from jsonb_array_elements(new.parts) with ordinality part(value,ordinality)
     where part.value->>'type'='attachment'
  loop
    if jsonb_typeof(v_part)<>'object' then
      raise exception 'attachment part must be an object';
    end if;
    if (select count(*) from jsonb_object_keys(v_part))<>7
       or not (v_part ?& array['type','attachment_ref','name','mime_type','version_id','sha256','byte_size'])
       or jsonb_typeof(v_part->'type')<>'string'
       or jsonb_typeof(v_part->'attachment_ref')<>'string'
       or jsonb_typeof(v_part->'name')<>'string'
       or jsonb_typeof(v_part->'mime_type')<>'string'
       or jsonb_typeof(v_part->'version_id')<>'string'
       or jsonb_typeof(v_part->'sha256')<>'string'
       or jsonb_typeof(v_part->'byte_size')<>'number'
       or v_part->>'byte_size'!~'^[1-9][0-9]*$' then
      raise exception 'attachment part must contain one exact immutable descriptor';
    end if;
    v_object_id:=substring(v_part->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$');
    if v_object_id is null then raise exception 'invalid storage object reference'; end if;
    select * into v_descriptor
      from public.mathpilot_storage_claim_owned_object(
        new.tenant_id,new.author_user_id,v_object_id,'thread','thread_attachment','message:'||new.message_id
      );
    if v_part->>'version_id'<>v_descriptor.version_id
       or v_part->>'sha256'<>v_descriptor.sha256
       or (v_part->>'byte_size')::bigint<>v_descriptor.byte_size
       or v_part->>'mime_type'<>v_descriptor.mime_type
       or v_part->>'name'<>v_descriptor.original_name then
      raise exception 'attachment descriptor does not match immutable object bytes';
    end if;
    if v_descriptor.mime_type not in (
      'application/json','text/plain','text/markdown','text/csv',
      'image/jpeg','image/png','image/webp','image/gif','image/bmp'
    ) then
      raise exception 'attachment MIME is not materializable by the Learning runtime';
    end if;
    v_total_bytes:=v_total_bytes+v_descriptor.byte_size;
    if v_total_bytes>50331648 then
      raise exception 'message attachments exceed 48 MiB';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function mathpilot_science_v3_claim_message_attachments() from public;

create or replace function mathpilot_science_v3_bind_message_attachments() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if TG_RELID<>'public.science_v3_canonical_message'::regclass
     or TG_OP not in ('INSERT','UPDATE') or TG_WHEN<>'AFTER' or TG_LEVEL<>'ROW' then
    raise exception 'invalid message attachment bind trigger context';
  end if;
  if TG_OP='UPDATE' and new.parts is not distinct from old.parts then
    return new;
  end if;
  insert into public.science_v3_message_attachment(
    tenant_id,conversation_thread_id,message_id,part_index,object_id,
    version_id,sha256,byte_size,mime_type,original_name,
    source_version_id,source_sha256,source_byte_size,source_mime_type,created_at
  )
  select new.tenant_id,new.conversation_thread_id,new.message_id,part.ordinality::integer-1,
         claim.object_id,claim.version_id,claim.sha256,claim.byte_size,claim.mime_type,
         claim.original_name,claim.source_version_id,claim.source_sha256,
         claim.source_byte_size,claim.source_mime_type,new.created_at
    from jsonb_array_elements(new.parts) with ordinality part(value,ordinality)
    join public.storage_object_claim claim
      on claim.tenant_id=new.tenant_id
     and claim.object_id=substring(part.value->>'attachment_ref' from '^storage-object:(obj_[A-Za-z0-9]{8,})$')
     and claim.claim_kind='thread_attachment' and claim.claim_ref='message:'||new.message_id
   where part.value->>'type'='attachment';
  return new;
end
$$;
revoke all on function mathpilot_science_v3_bind_message_attachments() from public;

create trigger science_v3_canonical_message_claim_attachments
  before insert or update on science_v3_canonical_message
  for each row execute function mathpilot_science_v3_claim_message_attachments();
create trigger science_v3_canonical_message_bind_attachments
  after insert or update on science_v3_canonical_message
  for each row execute function mathpilot_science_v3_bind_message_attachments();
create trigger science_v3_message_attachment_immutable
  before update or delete on science_v3_message_attachment
  for each row execute function forbid_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Avatar is now a claimed immutable object pointer, never application bytea
-- ─────────────────────────────────────────────────────────────────────────────
drop table identity_user_avatar;
create table identity_user_avatar (
  auth_user_id      text primary key references "user"(id),
  tenant_id         text not null references identity_tenant(tenant_id),
  owner_user_id     text not null references identity_user(user_id),
  storage_object_id text not null unique check (storage_object_id ~ '^obj_[A-Za-z0-9]{8,}$'),
  version_id        text not null,
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size         bigint not null check (byte_size between 1 and 786432),
  mime_type         text not null check (mime_type='image/webp'),
  updated_at        timestamptz not null default now(),
  foreign key(tenant_id,storage_object_id) references storage_object(tenant_id,object_id)
);
alter table identity_user_avatar enable row level security;
alter table identity_user_avatar force row level security;
create policy identity_user_avatar_owner on identity_user_avatar for select using (
  tenant_id=current_setting('app.current_tenant',true)
  and owner_user_id=current_setting('app.current_user',true)
);

create or replace function mathpilot_identity_set_avatar(
  p_tenant_id text,p_owner_user_id text,p_auth_user_id text,p_object_id text
) returns table (object_id text,version_id text,sha256 text,byte_size bigint,mime_type text)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_old_object_id text;
  v_object record;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'avatar actor mismatch';
  end if;
  perform 1 from public.identity_user identity
   where identity.tenant_id=p_tenant_id and identity.user_id=p_owner_user_id
     and identity.oidc_sub=p_auth_user_id
   for update;
  if not found then raise exception 'avatar actor mismatch'; end if;
  select avatar.storage_object_id into v_old_object_id
    from public.identity_user_avatar avatar where avatar.auth_user_id=p_auth_user_id for update;
  select * into v_object
    from public.mathpilot_storage_claim_owned_object(
      p_tenant_id,p_owner_user_id,p_object_id,'avatar','avatar','avatar:'||p_auth_user_id
    );
  if v_object.mime_type<>'image/webp' or v_object.byte_size>786432 then
    raise exception 'avatar object violates the canonical image policy';
  end if;
  insert into public.identity_user_avatar(
    auth_user_id,tenant_id,owner_user_id,storage_object_id,version_id,sha256,byte_size,mime_type,updated_at
  ) values (
    p_auth_user_id,p_tenant_id,p_owner_user_id,v_object.object_id,v_object.version_id,
    v_object.sha256,v_object.byte_size,v_object.mime_type,clock_timestamp()
  ) on conflict(auth_user_id) do update set
    storage_object_id=excluded.storage_object_id,version_id=excluded.version_id,
    sha256=excluded.sha256,byte_size=excluded.byte_size,mime_type=excluded.mime_type,
    updated_at=excluded.updated_at;
  if v_old_object_id is not null and v_old_object_id<>p_object_id then
    perform public.mathpilot_storage_release_owned_claim(
      p_tenant_id,p_owner_user_id,v_old_object_id,'avatar','avatar:'||p_auth_user_id
    );
  end if;
  return query select v_object.object_id,v_object.version_id,v_object.sha256,v_object.byte_size,v_object.mime_type;
end
$$;

create or replace function mathpilot_identity_remove_avatar(
  p_tenant_id text,p_owner_user_id text,p_auth_user_id text
) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_object_id text;
begin
  if p_tenant_id is distinct from current_setting('app.current_tenant',true)
     or p_owner_user_id is distinct from current_setting('app.current_user',true) then
    raise exception 'avatar actor mismatch';
  end if;
  perform 1 from public.identity_user identity
   where identity.tenant_id=p_tenant_id and identity.user_id=p_owner_user_id
     and identity.oidc_sub=p_auth_user_id
   for update;
  if not found then raise exception 'avatar actor mismatch'; end if;
  delete from public.identity_user_avatar avatar
   where avatar.auth_user_id=p_auth_user_id and avatar.tenant_id=p_tenant_id
     and avatar.owner_user_id=p_owner_user_id
   returning avatar.storage_object_id into v_object_id;
  if v_object_id is null then return false; end if;
  return public.mathpilot_storage_release_owned_claim(
    p_tenant_id,p_owner_user_id,v_object_id,'avatar','avatar:'||p_auth_user_id
  );
end
$$;
revoke all on function mathpilot_identity_set_avatar(text,text,text,text) from public;
revoke all on function mathpilot_identity_remove_avatar(text,text,text) from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage visibility: owner mutation plus bound-thread read, one SQL policy
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists tenant_isolation on storage_object;
create policy storage_object_owner_select on storage_object for select using (
  tenant_id=current_setting('app.current_tenant',true)
  and owner_user_id=current_setting('app.current_user',true)
);
create policy storage_object_owner_insert on storage_object for insert with check (
  tenant_id=current_setting('app.current_tenant',true)
  and owner_user_id=current_setting('app.current_user',true)
);
create policy storage_object_owner_update on storage_object for update using (
  tenant_id=current_setting('app.current_tenant',true)
  and owner_user_id=current_setting('app.current_user',true)
) with check (
  tenant_id=current_setting('app.current_tenant',true)
  and owner_user_id=current_setting('app.current_user',true)
);
create policy storage_object_owner_delete on storage_object for delete using (false);
create policy storage_object_bound_thread_select on storage_object for select using (
  tenant_id=current_setting('app.current_tenant',true) and purpose='thread' and state='ready'
  and exists (
    select 1 from science_v3_message_attachment binding
    join lateral mathpilot_science_v3_current_actor_thread(
      binding.tenant_id,binding.conversation_thread_id,false
    ) access on access.user_id=storage_object.owner_user_id
    where binding.tenant_id=storage_object.tenant_id and binding.object_id=storage_object.object_id
  )
);

alter table science_v3_message_attachment enable row level security;
alter table science_v3_message_attachment force row level security;
create policy science_v3_message_attachment_access on science_v3_message_attachment for select using (
  tenant_id=current_setting('app.current_tenant',true)
  and exists (
    select 1 from mathpilot_science_v3_current_actor_thread(
      science_v3_message_attachment.tenant_id,
      science_v3_message_attachment.conversation_thread_id,false
    )
  )
);

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    revoke all on storage_object,storage_object_claim from mathpilot_app;
    revoke all on content_candidate_source_object,content_candidate_source_seal from mathpilot_app;
    revoke update,delete on content_candidate_set from mathpilot_app;
    grant update(status,decided_at) on content_candidate_set to mathpilot_app;
    revoke update,delete on content_field_provenance from mathpilot_app;
    grant update(review_decision) on content_field_provenance to mathpilot_app;
    revoke update,delete on content_source from mathpilot_app;
    revoke insert,update,delete on content_source_page from mathpilot_app;
    revoke insert,update,delete on content_package from mathpilot_app;
    grant insert(package_id,tenant_id,origin,owner_teacher_user_id,title,version_no,status,
                 manifest_sha256,approved_er_candidate_set_id,created_at)
      on content_package to mathpilot_app;
    grant update(status) on content_package to mathpilot_app;
    revoke execute on function mathpilot_storage_begin_deletions(text,integer) from mathpilot_app;
    revoke execute on function mathpilot_storage_finish_deletion(text,text) from mathpilot_app;
    revoke execute on function mathpilot_storage_retry_deletion(text,text,text) from mathpilot_app;
    revoke all on science_v3_message_attachment,identity_user_avatar from mathpilot_app;
    grant select on science_v3_message_attachment,identity_user_avatar to mathpilot_app;
    grant select on content_candidate_source_object to mathpilot_app;
    grant execute on function mathpilot_science_v3_current_actor_students(text,boolean) to mathpilot_app;
    grant execute on function mathpilot_science_v3_current_actor_thread(text,text,boolean) to mathpilot_app;
    revoke execute on function mathpilot_storage_claim_owned_object(text,text,text,text,text,text) from mathpilot_app;
    revoke execute on function mathpilot_storage_release_owned_claim(text,text,text,text,text) from mathpilot_app;
    revoke execute on function mathpilot_content_claim_candidate_audit_object(text,text,text,text,text) from mathpilot_app;
    grant execute on function mathpilot_content_bind_candidate_source_object(text,text,text,text,text,text,text) to mathpilot_app;
    grant execute on function mathpilot_identity_set_avatar(text,text,text,text) to mathpilot_app;
    grant execute on function mathpilot_identity_remove_avatar(text,text,text) to mathpilot_app;
  end if;
  if exists (select 1 from pg_roles where rolname='mathpilot_storage') then
    grant usage on schema public to mathpilot_storage;
    grant select on infra_schema_migration,science_v3_message_attachment to mathpilot_storage;
    grant select,insert,update on storage_object to mathpilot_storage;
    revoke all on storage_object_claim from mathpilot_storage;
    grant execute on function mathpilot_science_v3_current_actor_students(text,boolean) to mathpilot_storage;
    grant execute on function mathpilot_science_v3_current_actor_thread(text,text,boolean) to mathpilot_storage;
    grant execute on function mathpilot_storage_begin_deletions(text,integer) to mathpilot_storage;
    grant execute on function mathpilot_storage_finish_deletion(text,text) to mathpilot_storage;
    grant execute on function mathpilot_storage_retry_deletion(text,text,text) to mathpilot_storage;
    grant execute on function mathpilot_storage_request_owned_deletion(text,text,text,text[]) to mathpilot_storage;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0041_content_integrity');
commit;
