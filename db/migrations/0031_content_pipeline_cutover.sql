-- 0031: KTQ/ER 正式内容库切换所需的单次 Schema。
--
-- 这不是旧表的兼容双写层：旧表只由一次性转换命令读取，应用切换后不再
-- 从旧 payload 管线读取。物理删除放在显式 cutover 脚本中，避免空库启动
-- 时在尚未导入官方清单的情况下丢失来源数据。
begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 统一身份与班级关系
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists identity_user_role (
  tenant_id           text not null references identity_tenant(tenant_id),
  user_id             text not null references identity_user(user_id) on delete cascade,
  role                text not null check (role in ('teacher', 'student')),
  assigned_by_user_id text references identity_user(user_id),
  assigned_at         timestamptz not null default now(),
  primary key (user_id, role)
);
create index if not exists identity_user_role_tenant_role_idx
  on identity_user_role (tenant_id, role, user_id);

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'identity_user_role_role_check'
       and conrelid = 'identity_user_role'::regclass
  ) then
    alter table identity_user_role drop constraint identity_user_role_role_check;
  end if;
  alter table identity_user_role
    add constraint identity_user_role_role_check check (role in ('teacher', 'student'));
end
$$;

-- 新事实源只保留显式 teacher/student。退役的管理员、审核和运维标签不
-- 自动升级为 teacher；没有显式产品角色的历史用户按认证默认值成为 student。
update identity_user u
   set roles = coalesce(
     (
       select array_agg(distinct mapped_role order by mapped_role)
         from (
           select case
             when r.role = 'teacher' then 'teacher'
             when r.role = 'student' then 'student'
             else null
           end as mapped_role
             from unnest(coalesce(u.roles, '{}'::text[])) as r(role)
         ) mapped
        where mapped_role is not null
     ),
     array['student']::text[]
   );

do $$
begin
  if exists (
    select 1 from identity_user u
     where 'teacher'=any(u.roles)
     group by u.tenant_id having count(*) > 1
  ) then
    raise exception 'content-next cutover requires exactly one teacher per tenant; reconcile identity_user before retrying';
  end if;
end
$$;

-- A stale normalized row from an abandoned partial migration must not retain
-- a role that is absent from the canonical two-value identity_user array.
delete from identity_user_role r
 using identity_user u
 where r.user_id=u.user_id and r.tenant_id=u.tenant_id
   and not (r.role=any(u.roles));

insert into identity_user_role (tenant_id, user_id, role)
select u.tenant_id, u.user_id, r.role
  from identity_user u
 cross join lateral unnest(coalesce(u.roles, '{}'::text[])) as r(role)
 where r.role in ('teacher', 'student')
on conflict (user_id, role) do nothing;
create unique index if not exists identity_user_role_single_teacher_idx
  on identity_user_role (tenant_id) where role='teacher';

create table if not exists identity_class_user (
  tenant_id        text not null references identity_tenant(tenant_id),
  class_id         text not null references identity_class(class_id) on delete cascade,
  user_id          text not null references identity_user(user_id) on delete cascade,
  class_role       text not null check (class_role in ('teacher', 'student')),
  status           text not null default 'active' check (status in ('active', 'revoked')),
  added_by_user_id text references identity_user(user_id),
  joined_at        timestamptz not null default now(),
  primary key (class_id, user_id)
);
create index if not exists identity_class_user_tenant_user_idx
  on identity_class_user (tenant_id, user_id, class_role, status, class_id);
create index if not exists identity_class_user_class_role_idx
  on identity_class_user (tenant_id, class_id, class_role, status);

alter table identity_class
  add column if not exists created_by_user_id text references identity_user(user_id),
  add column if not exists allow_official_content boolean not null default true,
  add column if not exists status text not null default 'active',
  add column if not exists updated_at timestamptz not null default now();
do $$
begin
  -- The next class relation is owned by a teacher.  Historical rows whose
  -- teacher_id cannot be traced to that role use the deterministic sole
  -- teacher/default administrator; the legacy teacher_id shadow is left
  -- untouched for the old services until the manual cutover.
  if exists (
    select 1 from identity_class c
     where not exists (
         select 1 from identity_user_role r
          where r.tenant_id=c.tenant_id
            and r.user_id=coalesce(c.created_by_user_id, c.teacher_id)
            and r.role='teacher'
       )
       and not exists (
         select 1 from identity_user_role r
          where r.tenant_id=c.tenant_id and r.role='teacher'
       )
  ) then
    raise exception 'cannot assign default teacher: identity_class has an untraceable owner';
  end if;
  update identity_class c
     set created_by_user_id = case
       when exists (
         select 1 from identity_user_role r
          where r.tenant_id=c.tenant_id and r.user_id=c.created_by_user_id and r.role='teacher'
       ) then c.created_by_user_id
       when exists (
         select 1 from identity_user_role r
          where r.tenant_id=c.tenant_id and r.user_id=c.teacher_id and r.role='teacher'
       ) then c.teacher_id
       else (
         select r.user_id from identity_user_role r
          join identity_user u on u.tenant_id=r.tenant_id and u.user_id=r.user_id
          where r.tenant_id=c.tenant_id and r.role='teacher'
          order by u.created_at,u.user_id limit 1
       )
     end,
         updated_at = coalesce(c.updated_at, c.created_at);
end
$$;
alter table identity_class alter column created_by_user_id set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'identity_class_status_check'
       and conrelid = 'identity_class'::regclass
  ) then
    alter table identity_class add constraint identity_class_status_check
      check (status in ('active', 'archived'));
  end if;
end
$$;

insert into identity_class_user
  (tenant_id, class_id, user_id, class_role, status, added_by_user_id, joined_at)
select c.tenant_id, c.class_id, c.created_by_user_id, 'teacher', 'active',
       c.created_by_user_id, c.created_at
  from identity_class c
on conflict (class_id, user_id) do update
  set class_role = 'teacher', status = 'active',
      added_by_user_id = coalesce(identity_class_user.added_by_user_id, excluded.added_by_user_id);

insert into identity_class_user
  (tenant_id, class_id, user_id, class_role, status, added_by_user_id, joined_at)
select m.tenant_id, m.class_id, m.student_id, 'student', 'active', m.student_id, m.created_at
  from identity_class_member m
 where not exists (
   select 1 from identity_class_user current
    where current.class_id = m.class_id and current.user_id = m.student_id
      and current.class_role = 'teacher'
 )
on conflict (class_id, user_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 私有对象登记（URL 不落库）
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists storage_object (
  object_id       text primary key,
  tenant_id       text not null references identity_tenant(tenant_id),
  bucket_name     text not null check (bucket_name in ('mathpilot-content', 'mathpilot-working', 'mathpilot-session')),
  object_key      text not null check (
    object_key !~ '(^|/)(\.\.?)(/|$)' and object_key !~ '[\\\x00]'
  ),
  version_id      text,
  etag            text,
  sha256          text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       bigint not null check (byte_size >= 0),
  mime_type       text not null check (length(mime_type) between 1 and 255),
  original_name   text,
  owner_user_id   text references identity_user(user_id),
  purpose         text not null check (purpose in ('source', 'candidate', 'package', 'thread', 'derived')),
  state           text not null default 'pending' check (state in ('pending', 'ready', 'failed', 'deleted')),
  created_at      timestamptz not null default now(),
  verified_at     timestamptz,
  unique (bucket_name, object_key, version_id)
);
create index if not exists storage_object_tenant_owner_idx
  on storage_object (tenant_id, owner_user_id, created_at desc);
create index if not exists storage_object_state_idx
  on storage_object (tenant_id, state, purpose, created_at desc);

alter table storage_object enable row level security;
alter table storage_object force row level security;
drop policy if exists tenant_isolation on storage_object;
create policy tenant_isolation on storage_object
  using (tenant_id = current_setting('app.current_tenant', true)
         and owner_user_id = current_setting('app.current_user', true))
  with check (tenant_id = current_setting('app.current_tenant', true)
              and owner_user_id = current_setting('app.current_user', true));

-- New content never reads or extends the legacy source_document/payload table.
-- The official importer records only the reviewed CSV manifest here; later
-- teacher uploads point to a verified storage_object.
create table if not exists content_source (
  source_id              text primary key,
  tenant_id              text not null references identity_tenant(tenant_id),
  origin                 text not null check (origin in ('official', 'teacher')),
  owner_teacher_user_id  text references identity_user(user_id),
  uploaded_by_user_id    text references identity_user(user_id),
  source_kind            text not null,
  original_sha256        text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  storage_object_id      text references storage_object(object_id),
  source_uri             text,
  verified_at            timestamptz,
  created_at             timestamptz not null default now(),
  check ((origin='official' and owner_teacher_user_id is null)
      or (origin='teacher' and owner_teacher_user_id is not null)),
  check (storage_object_id is not null or source_uri is not null),
  unique (tenant_id, original_sha256)
);
create index if not exists content_source_owner_idx
  on content_source (tenant_id, owner_teacher_user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- K/T/Q/E/R 实体与不可变修订
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists content_entity (
  entity_id             text primary key,
  tenant_id             text not null references identity_tenant(tenant_id),
  entity_kind           text not null check (entity_kind in ('knowledge', 'question_type', 'question', 'error_cause', 'diagnosis_rule')),
  origin                text not null check (origin in ('official', 'teacher')),
  owner_teacher_user_id text references identity_user(user_id),
  created_by_user_id    text references identity_user(user_id),
  created_at            timestamptz not null default now(),
  check ((origin = 'official' and owner_teacher_user_id is null)
      or (origin = 'teacher' and owner_teacher_user_id is not null))
);
create index if not exists content_entity_tenant_kind_idx
  on content_entity (tenant_id, entity_kind, created_at desc);
create index if not exists content_entity_owner_idx
  on content_entity (tenant_id, owner_teacher_user_id, entity_kind, created_at desc);

create table if not exists content_entity_revision (
  revision_id          text primary key,
  entity_id            text not null references content_entity(entity_id),
  tenant_id            text not null references identity_tenant(tenant_id),
  revision_no          integer not null check (revision_no > 0),
  candidate_set_id     text,
  lifecycle_status     text not null check (lifecycle_status in ('candidate', 'approved', 'ready', 'superseded', 'rejected')),
  created_by_thread_id text,
  model_id             text,
  prompt_version       text,
  created_at           timestamptz not null default now(),
  unique (entity_id, revision_no)
);
create index if not exists content_entity_revision_candidate_idx
  on content_entity_revision (tenant_id, candidate_set_id, lifecycle_status);
create index if not exists content_entity_revision_entity_idx
  on content_entity_revision (tenant_id, entity_id, revision_no desc);

create table if not exists content_knowledge_revision (
  revision_id        text primary key references content_entity_revision(revision_id) on delete cascade,
  tenant_id          text not null references identity_tenant(tenant_id),
  name               text not null,
  description        text not null default '',
  grade_band         text,
  difficulty         double precision check (difficulty is null or difficulty between 0 and 1),
  mastery_standard   text,
  remediation_advice text
);
create table if not exists content_question_type_revision (
  revision_id          text primary key references content_entity_revision(revision_id) on delete cascade,
  tenant_id             text not null references identity_tenant(tenant_id),
  name                  text not null,
  description           text not null default '',
  identifying_features  text not null default '',
  standard_method       text not null default ''
);
create table if not exists content_question_revision (
  revision_id               text primary key references content_entity_revision(revision_id) on delete cascade,
  tenant_id                 text not null references identity_tenant(tenant_id),
  chapter_id                text not null,
  stem_format               text not null check (stem_format in ('single_choice', 'multiple_choice', 'fill_blank', 'true_false', 'open_solution')),
  stem_markdown             text not null,
  difficulty                double precision not null check (difficulty between 0 and 1),
  question_type_revision_id text references content_question_type_revision(revision_id),
  analysis_markdown         text not null default ''
);
create index if not exists content_question_revision_chapter_idx
  on content_question_revision (tenant_id, chapter_id, revision_id);
create table if not exists content_error_cause_revision (
  revision_id      text primary key references content_entity_revision(revision_id) on delete cascade,
  tenant_id        text not null references identity_tenant(tenant_id),
  category         text not null default '',
  name             text not null,
  description      text not null,
  manifestation    text not null default '',
  judgment_basis   text not null default '',
  remediation      text not null default ''
);
create table if not exists content_diagnosis_rule_revision (
  revision_id   text primary key references content_entity_revision(revision_id) on delete cascade,
  tenant_id     text not null references identity_tenant(tenant_id),
  rule_version  text not null,
  trigger_text  text not null,
  probe_text    text not null
);

create table if not exists content_revision_item (
  item_id       text primary key,
  revision_id   text not null references content_entity_revision(revision_id) on delete cascade,
  tenant_id     text not null references identity_tenant(tenant_id),
  item_kind     text not null check (item_kind in (
    'knowledge_prerequisite', 'question_type_knowledge', 'question_option',
    'question_answer', 'question_rubric', 'question_measurement_target',
    'question_asset', 'error_cause_knowledge', 'diagnosis_rule_dimension',
    'diagnosis_rule_error_cause', 'diagnosis_rule_citation'
  )),
  position      integer not null check (position >= 0),
  created_at    timestamptz not null default now(),
  unique (revision_id, item_kind, position)
);
create table if not exists content_knowledge_prerequisite (
  item_id                 text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id               text not null references identity_tenant(tenant_id),
  prerequisite_revision_id text not null references content_knowledge_revision(revision_id),
  relation_kind           text not null default 'prerequisite'
);
create table if not exists content_question_type_knowledge (
  item_id              text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id            text not null references identity_tenant(tenant_id),
  knowledge_revision_id text not null references content_knowledge_revision(revision_id),
  role                 text not null check (role in ('primary', 'secondary', 'prerequisite'))
);
create table if not exists content_question_option (
  item_id       text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id     text not null references identity_tenant(tenant_id),
  option_key    text not null,
  option_text   text not null,
  is_correct    boolean not null default false
);
create table if not exists content_question_answer_item (
  item_id          text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id        text not null references identity_tenant(tenant_id),
  answer_text      text not null,
  equivalence_rule text
);
create table if not exists content_question_rubric_item (
  item_id      text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id    text not null references identity_tenant(tenant_id),
  criterion    text not null,
  score        numeric
);
create table if not exists content_question_measurement_target (
  item_id              text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id            text not null references identity_tenant(tenant_id),
  dimension_revision_id text not null references content_entity_revision(revision_id),
  target_role          text not null check (target_role in ('primary', 'secondary', 'prerequisite')),
  evidence_rule        text not null
);
create table if not exists content_error_cause_knowledge (
  item_id              text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id            text not null references identity_tenant(tenant_id),
  knowledge_revision_id text not null references content_knowledge_revision(revision_id),
  relation_kind        text not null default 'related'
);
create table if not exists content_diagnosis_rule_dimension (
  item_id              text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id            text not null references identity_tenant(tenant_id),
  dimension_revision_id text not null references content_entity_revision(revision_id)
);
create table if not exists content_diagnosis_rule_error_cause (
  item_id              text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id            text not null references identity_tenant(tenant_id),
  error_cause_revision_id text not null references content_error_cause_revision(revision_id)
);
create table if not exists content_diagnosis_rule_citation (
  item_id            text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id          text not null references identity_tenant(tenant_id),
  source_excerpt_id  text,
  claim_text         text not null
);

create table if not exists content_source_page (
  source_page_id  text primary key,
  tenant_id       text not null references identity_tenant(tenant_id),
  source_id       text not null references content_source(source_id) on delete cascade,
  page_no         integer not null check (page_no > 0),
  width           integer,
  height          integer,
  page_object_id  text references storage_object(object_id),
  unique (source_id, page_no)
);
create index if not exists content_source_page_tenant_idx
  on content_source_page (tenant_id, source_id, page_no);

create table if not exists content_source_excerpt (
  source_excerpt_id text primary key,
  tenant_id         text not null references identity_tenant(tenant_id),
  source_page_id    text not null references content_source_page(source_page_id) on delete cascade,
  fragment_no       integer not null check (fragment_no >= 0),
  fragment_kind     text not null,
  bbox              double precision[],
  text_content      text,
  content_sha256    text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz not null default now(),
  unique (source_page_id, fragment_no)
);
create index if not exists content_source_excerpt_page_idx
  on content_source_excerpt (tenant_id, source_page_id, fragment_no);

alter table content_diagnosis_rule_citation
  add constraint content_diagnosis_rule_citation_source_fk
  foreign key (source_excerpt_id) references content_source_excerpt(source_excerpt_id);

create table if not exists content_question_asset_revision (
  item_id            text primary key references content_revision_item(item_id) on delete cascade,
  tenant_id          text not null references identity_tenant(tenant_id),
  storage_object_id  text references storage_object(object_id),
  asset_role         text not null,
  source_locator     text,
  mime_type          text,
  content_sha256     text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  check (storage_object_id is not null or source_locator is not null)
);

create table if not exists content_field_provenance (
  provenance_id       bigint generated always as identity primary key,
  tenant_id           text not null references identity_tenant(tenant_id),
  revision_id         text not null references content_entity_revision(revision_id) on delete cascade,
  revision_item_id    text references content_revision_item(item_id),
  field_name          text not null,
  source_excerpt_id   text references content_source_excerpt(source_excerpt_id),
  source_object_id    text references storage_object(object_id),
  thread_id           text,
  tool_call_id        text,
  source_locator      text,
  derivation_type     text not null check (derivation_type in ('source_extract','model_generation','human_authored')),
  provenance_status   text not null check (provenance_status in ('direct','derived','model_generated','human_authored')),
  review_decision     text check (review_decision in ('confirmed','modified','rejected','pending')),
  created_at          timestamptz not null default now()
);
create index if not exists content_field_provenance_revision_idx
  on content_field_provenance (tenant_id, revision_id, revision_item_id, field_name);

-- ─────────────────────────────────────────────────────────────────────────────
-- 候选集、字段复核和事务性 ER handoff 命令
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists content_candidate_set (
  candidate_set_id             text primary key,
  tenant_id                    text not null references identity_tenant(tenant_id),
  phase                        text not null check (phase in ('ktq', 'er')),
  owner_teacher_user_id        text not null references identity_user(user_id),
  thread_id                    text not null,
  sequence_no                  integer not null check (sequence_no > 0),
  input_candidate_set_id       text references content_candidate_set(candidate_set_id),
  supersedes_candidate_set_id  text references content_candidate_set(candidate_set_id),
  result_object_id             text not null references storage_object(object_id),
  receipt_object_id            text not null references storage_object(object_id),
  result_sha256                text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  respond_tool_call_id         text not null,
  status                       text not null default 'pending_review'
    check (status in ('pending_review', 'changes_requested', 'approved', 'superseded')),
  created_at                   timestamptz not null default now(),
  decided_at                   timestamptz,
  check (result_object_id <> receipt_object_id),
  unique (tenant_id, thread_id, phase, sequence_no),
  unique (tenant_id, thread_id, phase, respond_tool_call_id)
);
create index if not exists content_candidate_set_owner_status_idx
  on content_candidate_set (tenant_id, owner_teacher_user_id, status, created_at desc);
create index if not exists content_candidate_set_thread_idx
  on content_candidate_set (tenant_id, thread_id, phase, sequence_no desc);

create or replace function mathpilot_candidate_set_guard()
returns trigger language plpgsql as $$
declare input_phase text; input_status text;
begin
  if new.phase = 'ktq' and new.input_candidate_set_id is not null then
    raise exception 'KTQ candidate cannot have an input candidate set';
  end if;
  if new.phase = 'er' then
    if new.input_candidate_set_id is null then
      raise exception 'ER candidate requires an approved KTQ input';
    end if;
    select phase, status into input_phase, input_status
      from content_candidate_set where candidate_set_id = new.input_candidate_set_id;
    if input_phase is distinct from 'ktq' or input_status is distinct from 'approved' then
      raise exception 'ER input must be an approved KTQ candidate';
    end if;
  end if;
  if new.supersedes_candidate_set_id is not null then
    if not exists (
      select 1 from content_candidate_set old
       where old.candidate_set_id = new.supersedes_candidate_set_id
         and old.tenant_id = new.tenant_id and old.thread_id = new.thread_id
         and old.phase = new.phase and old.owner_teacher_user_id = new.owner_teacher_user_id
         and old.status = 'changes_requested'
    ) then
      raise exception 'superseded candidate must be the same thread/phase and marked changes_requested';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists content_candidate_set_guard on content_candidate_set;
create trigger content_candidate_set_guard before insert or update on content_candidate_set
  for each row execute function mathpilot_candidate_set_guard();

create table if not exists content_candidate_set_item (
  tenant_id       text not null references identity_tenant(tenant_id),
  candidate_set_id text not null references content_candidate_set(candidate_set_id) on delete cascade,
  revision_id     text not null references content_entity_revision(revision_id),
  item_order      integer not null check (item_order >= 0),
  primary key (candidate_set_id, revision_id),
  unique (candidate_set_id, item_order)
);
create index if not exists content_candidate_set_item_revision_idx
  on content_candidate_set_item (tenant_id, revision_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'content_entity_revision_candidate_set_fk'
       and conrelid = 'content_entity_revision'::regclass
  ) then
    alter table content_entity_revision
      add constraint content_entity_revision_candidate_set_fk
      foreign key (candidate_set_id) references content_candidate_set(candidate_set_id);
  end if;
end
$$;

create table if not exists content_review_annotation (
  annotation_id   text primary key,
  tenant_id       text not null references identity_tenant(tenant_id),
  candidate_set_id text not null references content_candidate_set(candidate_set_id) on delete cascade,
  revision_id     text not null references content_entity_revision(revision_id),
  revision_item_id text references content_revision_item(item_id),
  field_name      text,
  comment_text    text not null check (length(btrim(comment_text)) between 1 and 10000),
  author_user_id  text not null references identity_user(user_id),
  state           text not null default 'draft' check (state in ('draft', 'submitted', 'withdrawn')),
  created_at      timestamptz not null default now(),
  withdrawn_at    timestamptz,
  submitted_at    timestamptz,
  check (revision_item_id is null or field_name is not null)
);
create index if not exists content_review_annotation_candidate_idx
  on content_review_annotation (tenant_id, candidate_set_id, state, created_at);

create table if not exists content_review_decision (
  decision_id        text primary key,
  tenant_id          text not null references identity_tenant(tenant_id),
  candidate_set_id   text not null references content_candidate_set(candidate_set_id) on delete cascade,
  decision           text not null check (decision in ('changes_requested', 'approved')),
  decided_by_user_id text not null references identity_user(user_id),
  decided_at         timestamptz not null default now(),
  feedback_attempt_count integer not null default 0 check (feedback_attempt_count >= 0),
  feedback_last_error text,
  feedback_next_attempt_at timestamptz not null default now(),
  feedback_dispatched_at timestamptz,
  unique (candidate_set_id)
);
alter table content_review_decision add column if not exists feedback_attempt_count integer not null default 0 check (feedback_attempt_count >= 0);
alter table content_review_decision add column if not exists feedback_last_error text;
alter table content_review_decision add column if not exists feedback_next_attempt_at timestamptz not null default now();
alter table content_review_decision add column if not exists feedback_dispatched_at timestamptz;
create index if not exists content_review_decision_feedback_idx
  on content_review_decision (feedback_next_attempt_at, decided_at)
  where decision='changes_requested' and feedback_dispatched_at is null;
create table if not exists content_er_start_command (
  command_id                    text primary key,
  tenant_id                     text not null references identity_tenant(tenant_id),
  approved_ktq_candidate_set_id text not null references content_candidate_set(candidate_set_id),
  target_thread_id              text not null,
  status                        text not null default 'pending' check (status in ('pending', 'dispatched')),
  attempt_count                 integer not null default 0 check (attempt_count >= 0),
  last_error                    text,
  next_attempt_at               timestamptz not null default now(),
  created_at                    timestamptz not null default now(),
  dispatched_at                 timestamptz,
  unique (approved_ktq_candidate_set_id),
  unique (target_thread_id)
);
create index if not exists content_er_start_command_pending_idx
  on content_er_start_command (status, next_attempt_at, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 教师包和班级发布关系
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists content_package (
  package_id                   text primary key,
  tenant_id                    text not null references identity_tenant(tenant_id),
  origin                       text not null check (origin in ('official', 'teacher')),
  owner_teacher_user_id        text references identity_user(user_id),
  title                        text not null,
  version_no                   integer not null check (version_no > 0),
  status                       text not null default 'ready' check (status in ('ready', 'published', 'withdrawn')),
  manifest_object_id           text references storage_object(object_id),
  manifest_sha256              text check (manifest_sha256 is null or manifest_sha256 ~ '^[0-9a-f]{64}$'),
  approved_er_candidate_set_id text references content_candidate_set(candidate_set_id),
  created_at                   timestamptz not null default now(),
  check ((origin = 'official' and owner_teacher_user_id is null and approved_er_candidate_set_id is null)
      or (origin = 'teacher' and owner_teacher_user_id is not null and approved_er_candidate_set_id is not null))
);
create unique index if not exists content_package_tenant_owner_version_idx
  on content_package (tenant_id, owner_teacher_user_id, version_no);
create index if not exists content_package_owner_status_idx
  on content_package (tenant_id, owner_teacher_user_id, status, created_at desc);
create table if not exists content_package_item (
  tenant_id   text not null references identity_tenant(tenant_id),
  package_id  text not null references content_package(package_id) on delete cascade,
  revision_id text not null references content_entity_revision(revision_id),
  item_order  integer not null check (item_order >= 0),
  primary key (package_id, revision_id),
  unique (package_id, item_order)
);
create table if not exists content_package_class_release (
  release_id          text primary key,
  tenant_id           text not null references identity_tenant(tenant_id),
  package_id          text not null references content_package(package_id) on delete cascade,
  class_id            text not null references identity_class(class_id) on delete cascade,
  published_by_user_id text not null references identity_user(user_id),
  published_at        timestamptz not null default now(),
  withdrawn_at        timestamptz,
  unique (package_id, class_id)
);
create index if not exists content_package_release_class_idx
  on content_package_class_release (tenant_id, class_id, withdrawn_at, published_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS、不可变事实和统一可见性函数
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'identity_user_role', 'identity_class_user', 'storage_object',
    'content_entity', 'content_entity_revision', 'content_knowledge_revision',
    'content_question_type_revision', 'content_question_revision',
    'content_error_cause_revision', 'content_diagnosis_rule_revision',
    'content_revision_item', 'content_knowledge_prerequisite',
    'content_question_type_knowledge', 'content_question_option',
    'content_question_answer_item', 'content_question_rubric_item',
    'content_question_measurement_target', 'content_error_cause_knowledge',
    'content_diagnosis_rule_dimension', 'content_diagnosis_rule_error_cause',
    'content_diagnosis_rule_citation', 'content_source', 'content_source_page',
    'content_source_excerpt', 'content_question_asset_revision', 'content_field_provenance',
    'content_candidate_set', 'content_candidate_set_item',
    'content_review_annotation', 'content_review_decision', 'content_er_start_command',
    'content_package', 'content_package_item', 'content_package_class_release'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
  end loop;
end
$$;

create policy tenant_isolation on identity_user_role using
  (tenant_id = current_setting('app.current_tenant', true)) with check
  (tenant_id = current_setting('app.current_tenant', true));
create policy tenant_isolation on identity_class_user using
  (tenant_id = current_setting('app.current_tenant', true)) with check
  (tenant_id = current_setting('app.current_tenant', true));
create policy tenant_isolation on storage_object using
  (tenant_id = current_setting('app.current_tenant', true)
   and owner_user_id = current_setting('app.current_user', true)) with check
  (tenant_id = current_setting('app.current_tenant', true)
   and owner_user_id = current_setting('app.current_user', true));

do $$
declare t text;
begin
  foreach t in array array[
    'content_entity', 'content_entity_revision', 'content_knowledge_revision',
    'content_question_type_revision', 'content_question_revision',
    'content_error_cause_revision', 'content_diagnosis_rule_revision',
    'content_revision_item', 'content_knowledge_prerequisite',
    'content_question_type_knowledge', 'content_question_option',
    'content_question_answer_item', 'content_question_rubric_item',
    'content_question_measurement_target', 'content_error_cause_knowledge',
    'content_diagnosis_rule_dimension', 'content_diagnosis_rule_error_cause',
    'content_diagnosis_rule_citation', 'content_source', 'content_source_page',
    'content_source_excerpt', 'content_question_asset_revision', 'content_field_provenance'
  ] loop
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.current_tenant'', true)) with check (tenant_id = current_setting(''app.current_tenant'', true))', t
    );
  end loop;
end
$$;

create policy tenant_isolation on content_candidate_set using (
  tenant_id = current_setting('app.current_tenant', true)
  and owner_teacher_user_id = current_setting('app.current_user', true)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and owner_teacher_user_id = current_setting('app.current_user', true)
);
create policy tenant_isolation on content_candidate_set_item using (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_candidate_set s where s.candidate_set_id = content_candidate_set_item.candidate_set_id)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_candidate_set s where s.candidate_set_id = content_candidate_set_item.candidate_set_id)
);
create policy tenant_isolation on content_review_annotation using (
  tenant_id = current_setting('app.current_tenant', true)
  and (author_user_id = current_setting('app.current_user', true)
       or exists (select 1 from content_candidate_set s where s.candidate_set_id = content_review_annotation.candidate_set_id))
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and author_user_id = current_setting('app.current_user', true)
  and exists (select 1 from content_candidate_set s where s.candidate_set_id = content_review_annotation.candidate_set_id)
);
create policy tenant_isolation on content_review_decision using (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_candidate_set s where s.candidate_set_id = content_review_decision.candidate_set_id)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and decided_by_user_id = current_setting('app.current_user', true)
  and exists (select 1 from content_candidate_set s where s.candidate_set_id = content_review_decision.candidate_set_id)
);
create policy tenant_isolation on content_er_start_command using
  (tenant_id = current_setting('app.current_tenant', true));
drop policy if exists content_package_teacher_write on content_package;
create policy tenant_isolation on content_package for select using (
  tenant_id = current_setting('app.current_tenant', true)
);
create policy content_package_teacher_write on content_package for all using (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and (owner_teacher_user_id = current_setting('app.current_user', true)
       or (origin='official' and owner_teacher_user_id is null))
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and (owner_teacher_user_id = current_setting('app.current_user', true)
       or (origin='official' and owner_teacher_user_id is null))
);
create policy tenant_isolation on content_package_item using (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_package p where p.package_id = content_package_item.package_id)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_package p where p.package_id = content_package_item.package_id)
);
create policy tenant_isolation on content_package_class_release using (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_package p where p.package_id = content_package_class_release.package_id)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and published_by_user_id = current_setting('app.current_user', true)
  and exists (select 1 from content_package p where p.package_id = content_package_class_release.package_id)
);

create or replace function mathpilot_revision_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'content revision is immutable'; end if;
  if new.entity_id is distinct from old.entity_id
     or new.tenant_id is distinct from old.tenant_id
     or new.revision_no is distinct from old.revision_no
     or new.candidate_set_id is distinct from old.candidate_set_id
     or new.created_by_thread_id is distinct from old.created_by_thread_id
     or new.model_id is distinct from old.model_id
     or new.prompt_version is distinct from old.prompt_version
     or new.created_at is distinct from old.created_at then
    raise exception 'content revision fields are immutable';
  end if;
  if old.lifecycle_status = new.lifecycle_status
     or (old.lifecycle_status = 'candidate' and new.lifecycle_status in ('approved', 'superseded', 'rejected'))
     or (old.lifecycle_status = 'approved' and new.lifecycle_status = 'ready') then
    return new;
  end if;
  raise exception 'invalid content revision status transition % -> %', old.lifecycle_status, new.lifecycle_status;
end
$$;
drop trigger if exists content_entity_revision_guard on content_entity_revision;
create trigger content_entity_revision_guard before update or delete on content_entity_revision
  for each row execute function mathpilot_revision_guard();

do $$
declare t text;
begin
  foreach t in array array[
    'content_entity', 'content_knowledge_revision', 'content_question_type_revision',
    'content_question_revision', 'content_error_cause_revision',
    'content_diagnosis_rule_revision', 'content_revision_item',
    'content_knowledge_prerequisite', 'content_question_type_knowledge',
    'content_question_option', 'content_question_answer_item',
    'content_question_rubric_item', 'content_question_measurement_target',
    'content_error_cause_knowledge', 'content_diagnosis_rule_dimension',
    'content_diagnosis_rule_error_cause', 'content_diagnosis_rule_citation',
    'content_source', 'content_source_page', 'content_source_excerpt',
    'content_question_asset_revision'
  ] loop
    execute format('drop trigger if exists %I on %I', t || '_immutable', t);
    execute format('create trigger %I before update or delete on %I for each row execute function forbid_mutation()', t || '_immutable', t);
  end loop;
end
$$;

create or replace function mathpilot_review_decision_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare candidate public.content_candidate_set%rowtype;
begin
  select * into candidate from public.content_candidate_set
   where candidate_set_id = new.candidate_set_id for update;
  if not found then raise exception 'candidate set not found'; end if;
  if candidate.status <> 'pending_review' then raise exception 'candidate set is already finalized'; end if;
  if new.decision = 'approved' and exists (
    select 1 from public.content_review_annotation a
     where a.candidate_set_id = new.candidate_set_id and a.state in ('draft', 'submitted')
  ) then raise exception 'candidate set has active annotations'; end if;
  if new.decision = 'changes_requested' and not exists (
    select 1 from public.content_review_annotation a
     where a.candidate_set_id = new.candidate_set_id and a.state in ('draft', 'submitted')
  ) then raise exception 'changes require at least one active annotation'; end if;
  return new;
end
$$;
drop trigger if exists content_review_decision_guard on content_review_decision;
create trigger content_review_decision_guard before insert on content_review_decision
  for each row execute function mathpilot_review_decision_guard();

create or replace function mathpilot_review_annotation_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare candidate_status text;
begin
  if tg_op = 'DELETE' then raise exception 'review annotations cannot be deleted'; end if;
  select status into candidate_status from public.content_candidate_set
   where candidate_set_id = new.candidate_set_id;
  if candidate_status is distinct from 'pending_review' then
    raise exception 'annotations are frozen after review decision';
  end if;
  return new;
end
$$;
drop trigger if exists content_review_annotation_guard on content_review_annotation;
create trigger content_review_annotation_guard before insert or update or delete on content_review_annotation
  for each row execute function mathpilot_review_annotation_guard();

create or replace function mathpilot_package_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'content package is immutable'; end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.origin is distinct from old.origin
     or new.owner_teacher_user_id is distinct from old.owner_teacher_user_id
     or new.title is distinct from old.title
     or new.version_no is distinct from old.version_no
     or new.manifest_object_id is distinct from old.manifest_object_id
     or new.manifest_sha256 is distinct from old.manifest_sha256
     or new.approved_er_candidate_set_id is distinct from old.approved_er_candidate_set_id
     or new.created_at is distinct from old.created_at then
    raise exception 'content package identity is immutable';
  end if;
  if old.status = new.status or (old.status = 'ready' and new.status in ('published', 'withdrawn')) then return new; end if;
  raise exception 'invalid content package status transition % -> %', old.status, new.status;
end
$$;
drop trigger if exists content_package_guard on content_package;
create trigger content_package_guard before update or delete on content_package
  for each row execute function mathpilot_package_guard();
drop trigger if exists content_package_item_immutable on content_package_item;
create trigger content_package_item_immutable before update or delete on content_package_item
  for each row execute function forbid_mutation();

create or replace function mathpilot_content_entity_visible(
  p_tenant text, p_user text, p_roles text[], p_entity_kind text, p_entity_id text,
  p_model_scope boolean default false
) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.content_entity e
     where e.tenant_id = p_tenant and e.entity_kind = p_entity_kind and e.entity_id = p_entity_id
       and (
         (e.origin = 'teacher' and e.owner_teacher_user_id = p_user)
         or (e.origin = 'official' and (
           coalesce('teacher' = any(p_roles), false)
           or (coalesce('student' = any(p_roles), false) and (
             not exists (select 1 from public.identity_class_user cu where cu.tenant_id=p_tenant and cu.user_id=p_user and cu.class_role='student' and cu.status='active')
             or exists (
               select 1 from public.identity_class_user cu join public.identity_class c on c.class_id=cu.class_id
                where cu.tenant_id=p_tenant and cu.user_id=p_user and cu.class_role='student' and cu.status='active'
                  and c.status='active' and c.allow_official_content
             )
           ))
         ))
         or (not p_model_scope and exists (
           select 1 from public.content_package_item pi
           join public.content_package p on p.package_id=pi.package_id
           join public.content_package_class_release cr on cr.package_id=p.package_id
           join public.identity_class_user cu on cu.class_id=cr.class_id
           join public.identity_class c on c.class_id=cr.class_id and c.tenant_id=cr.tenant_id
          where p.tenant_id=p_tenant and p.status in ('ready','published') and pi.tenant_id=p_tenant
            and pi.revision_id in (select r.revision_id from public.content_entity_revision r where r.tenant_id=p_tenant and r.entity_id=e.entity_id)
            and cr.tenant_id=p_tenant and cr.withdrawn_at is null and c.status='active'
            and cu.tenant_id=p_tenant and cu.user_id=p_user and cu.status='active'
         ))
       )
  )
$$;

create or replace function mathpilot_content_package_visible(
  p_tenant text, p_user text, p_roles text[], p_package_id text, p_model_scope boolean default false
) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.content_package p
     where p.tenant_id=p_tenant and p.package_id=p_package_id and p.status in ('ready','published')
       and (
         (p.origin='teacher' and p.owner_teacher_user_id=p_user)
         or (p.origin='official' and (
           coalesce('teacher'=any(p_roles),false)
           or (coalesce('student'=any(p_roles),false) and (
             not exists (select 1 from public.identity_class_user cu where cu.tenant_id=p_tenant and cu.user_id=p_user and cu.class_role='student' and cu.status='active')
             or exists (select 1 from public.identity_class_user cu join public.identity_class c on c.class_id=cu.class_id where cu.tenant_id=p_tenant and cu.user_id=p_user and cu.class_role='student' and cu.status='active' and c.status='active' and c.allow_official_content)
           ))
         ))
         or (not p_model_scope and exists (
           select 1 from public.content_package_class_release cr
           join public.identity_class_user cu on cu.class_id=cr.class_id
           join public.identity_class c on c.class_id=cr.class_id and c.tenant_id=cr.tenant_id
            where cr.tenant_id=p_tenant and cr.package_id=p.package_id and cr.withdrawn_at is null
              and c.status='active' and cu.tenant_id=p_tenant and cu.user_id=p_user and cu.status='active'
         ))
       )
  )
$$;

create or replace function mathpilot_content_candidate_visible(
  p_tenant text, p_user text, p_roles text[], p_candidate_set_id text
) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.content_candidate_set s
     where s.tenant_id=p_tenant and s.candidate_set_id=p_candidate_set_id
       and s.owner_teacher_user_id=p_user and coalesce('teacher'=any(p_roles),false)
  )
$$;

create or replace function mathpilot_content_can_publish_package(
  p_tenant text, p_user text, p_roles text[], p_package_id text, p_class_id text
) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (
    select 1 from public.content_package p join public.identity_class_user cu
      on cu.tenant_id=p_tenant and cu.class_id=p_class_id and cu.user_id=p_user and cu.class_role='teacher' and cu.status='active'
   where p.tenant_id=p_tenant and p.package_id=p_package_id and p.origin='teacher' and p.owner_teacher_user_id=p_user and p.status in ('ready','published')
  )
$$;

create or replace function mathpilot_pending_er_start_commands()
returns table(command_id text, tenant_id text, owner_user_id text, approved_ktq_candidate_set_id text, target_thread_id text, attempt_count integer)
language sql stable security definer set search_path = pg_catalog, public as $$
  select c.command_id,c.tenant_id,s.owner_teacher_user_id,c.approved_ktq_candidate_set_id,c.target_thread_id,c.attempt_count
    from public.content_er_start_command c
    join public.content_candidate_set s on s.candidate_set_id=c.approved_ktq_candidate_set_id
   where c.status='pending' and c.next_attempt_at <= now() order by c.created_at
$$;
revoke all on function mathpilot_pending_er_start_commands() from public;

create or replace function mathpilot_pending_review_feedback_commands()
returns table(
  command_id text,
  tenant_id text,
  owner_user_id text,
  candidate_set_id text,
  target_thread_id text,
  phase text,
  annotations jsonb,
  attempt_count integer
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select d.decision_id,d.tenant_id,s.owner_teacher_user_id,s.candidate_set_id,s.thread_id,s.phase,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'revision_id',a.revision_id,
             'revision_item_id',a.revision_item_id,
             'field_name',a.field_name,
             'comment_text',a.comment_text
           ) order by a.created_at)
             from public.content_review_annotation a
            where a.candidate_set_id=d.candidate_set_id and a.state in ('draft','submitted')
         ), '[]'::jsonb),
         d.feedback_attempt_count
    from public.content_review_decision d
    join public.content_candidate_set s on s.candidate_set_id=d.candidate_set_id
   where d.decision='changes_requested'
     and d.feedback_dispatched_at is null
     and d.feedback_next_attempt_at <= now()
   order by d.decided_at
$$;
revoke all on function mathpilot_pending_review_feedback_commands() from public;

-- FTS 是结构化字段的索引，不为旧 payload 建索引。
create index if not exists content_knowledge_revision_search_idx on content_knowledge_revision using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,'')));
create index if not exists content_question_type_revision_search_idx on content_question_type_revision using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(standard_method,'')));
create index if not exists content_question_revision_search_idx on content_question_revision using gin (to_tsvector('simple', coalesce(stem_markdown,'') || ' ' || coalesce(analysis_markdown,'')));
create index if not exists content_error_cause_revision_search_idx on content_error_cause_revision using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(remediation,'')));
create index if not exists content_diagnosis_rule_revision_search_idx on content_diagnosis_rule_revision using gin (to_tsvector('simple', coalesce(trigger_text,'') || ' ' || coalesce(probe_text,'')));

do $$
begin
  if exists (select 1 from pg_roles where rolname='mathpilot_app') then
    grant select,insert,update,delete on all tables in schema public to mathpilot_app;
    grant usage,select,update on all sequences in schema public to mathpilot_app;
    grant execute on function mathpilot_content_entity_visible(text,text,text[],text,text,boolean) to mathpilot_app;
    grant execute on function mathpilot_content_package_visible(text,text,text[],text,boolean) to mathpilot_app;
    grant execute on function mathpilot_content_candidate_visible(text,text,text[],text) to mathpilot_app;
    grant execute on function mathpilot_content_can_publish_package(text,text,text[],text,text) to mathpilot_app;
    grant execute on function mathpilot_pending_er_start_commands() to mathpilot_app;
    grant execute on function mathpilot_pending_review_feedback_commands() to mathpilot_app;
  end if;
end
$$;

insert into infra_schema_migration(version) values ('0031_content_pipeline_cutover') on conflict (version) do nothing;
commit;
