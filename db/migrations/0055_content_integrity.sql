-- 0055: merged-line content integrity — one immutable object lifecycle, one
-- Science-v3 access projection, one storage claim authority.
--
-- Lineage: local 0041_content_integrity, adapted for the teammate 0904
-- product line (applies after teammate 0041-0054). Deliberate divergences
-- from the original 0041, all documented here:
--   1. purpose enum includes 'paper' (teammate 0050).
--   2. Lifecycle columns are additive and nullable: the merged storage
--      service writes pending->ready directly and does not yet exercise
--      quarantine/verification, so the fresh-cutover refusal guards and
--      the ready/expiry shape checks are NOT ported.
--   3. The storage guard permits the teammate pending->ready transition.
--   4. Candidate-source seal, candidate audit claim trigger and projection
--      validation triggers are NOT ported: the teammate KTQ/ER pipeline
--      does not bind candidate source objects and would be rejected.
--   5. Avatar stays the teammate bytea shape: the object-based avatar
--      authority (mathpilot_identity_set_avatar) is NOT ported.
--   6. Canonical-message attachment claim triggers are NOT ported: the
--      teammate attachment parts are workspace references, not exact
--      7-field immutable descriptors.
--   7. RLS tightening is NOT ported: the base tenant_isolation policy
--      remains the storage visibility rule.
-- Kept from 0041: claim/release/request-deletion/lease functions,
-- tenant-composite FKs, actor projections, identity/bytes immutability
-- guard, expiry index, deletion lease machinery (drives storage GC).
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

-- The merged storage service writes byte size and MIME at insert, so these
-- stay NOT NULL; the declaration columns above remain nullable until the
-- quarantine flow is adopted.
alter table storage_object
  drop constraint if exists storage_object_purpose_check,
  drop constraint if exists storage_object_state_check;

alter table storage_object
  add constraint storage_object_purpose_check
    check (purpose in ('source','candidate','package','thread','derived','paper','avatar')),
  add constraint storage_object_state_check
    check (state in ('pending','verifying','ready','failed','deleting','deleted')),
  add constraint storage_object_source_sha_check
    check (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint storage_object_source_size_check
    check (source_byte_size is null or source_byte_size between 1 and 50331648),
  add constraint storage_object_source_key_check
    check (source_object_key is null or (source_object_key !~ '(^|/)(\.\.?)(/|$)' and source_object_key !~ '[\\\x00]')),
  add constraint storage_object_verification_attempts_check
    check (verification_attempts between 0 and 16),
  add constraint storage_object_deletion_attempts_check
    check (deletion_attempts>=0);

create index storage_object_expiry_idx
  on storage_object(state,expires_at) where state in ('pending','verifying','ready','failed','deleting');
alter table storage_object add constraint storage_object_tenant_object_unique unique(tenant_id,object_id);

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
    (old.state='pending' and new.state in ('verifying','ready','failed','deleting'))
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
    or (p_claim_kind='content_source' and p_purpose in ('source','thread','derived','paper'))
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
     or coalesce(cardinality(p_allowed_purposes),0) not between 1 and 7
     or not (p_allowed_purposes <@ array['source','candidate','package','thread','derived','paper','avatar']::text[]) then
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage owns expiry and physical deletion.  The application role can only
-- lease bounded batches through these security-definer functions; it never
-- receives a cross-tenant table policy or a reusable "system principal".
-- ─────────────────────────────────────────────────────────────────────────────
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
-- Role wiring: only the additive grants for the merged line. Privilege
-- tightening and RLS changes from 0041 are deferred until the merged storage
-- service adopts the quarantine/verification lifecycle.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant execute on function mathpilot_science_v3_current_actor_students(text,boolean) to mathpilot_app;
    grant execute on function mathpilot_science_v3_current_actor_thread(text,text,boolean) to mathpilot_app;
    revoke execute on function mathpilot_storage_claim_owned_object(text,text,text,text,text,text) from mathpilot_app;
    revoke execute on function mathpilot_storage_release_owned_claim(text,text,text,text,text) from mathpilot_app;
  end if;
  if exists (select 1 from pg_roles where rolname='mathpilot_storage') then
    grant usage on schema public to mathpilot_storage;
    grant select on infra_schema_migration to mathpilot_storage;
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

insert into infra_schema_migration(version) values ('0055_content_integrity');
commit;
