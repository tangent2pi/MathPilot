-- 0002: content 族（设计 §14.2）— 文档、片段、K/T/E/Q/R、章节包、字段血缘
begin;

create table content_source_document (
  document_id    text primary key,
  tenant_id      text not null references identity_tenant(tenant_id),
  kind           text not null,
  original_hash  text not null,
  storage_ref    text not null,
  ocr_status     text not null default 'pending',
  uploaded_by    text not null references identity_user(user_id),
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, original_hash)
);
create index content_source_document_tenant_idx on content_source_document(tenant_id);

create table content_source_fragment (
  fragment_id    text primary key,
  tenant_id      text not null,
  document_id    text not null references content_source_document(document_id),
  page_no        integer not null,
  fragment_type  text not null,
  bbox           double precision[],
  content_hash   text,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index content_source_fragment_doc_idx on content_source_fragment(document_id);
create index content_source_fragment_tenant_idx on content_source_fragment(tenant_id);

create table content_knowledge_component (
  dimension_id   text primary key,
  tenant_id      text not null,
  name           text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index content_kc_tenant_idx on content_knowledge_component(tenant_id);

create table content_question_type (
  dimension_id   text primary key,
  tenant_id      text not null,
  name           text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index content_qt_tenant_idx on content_question_type(tenant_id);

create table content_error_cause (
  dimension_id   text primary key,
  tenant_id      text not null,
  name           text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index content_ec_tenant_idx on content_error_cause(tenant_id);

create table content_diagnosis_rule (
  rule_id        text primary key,
  tenant_id      text not null,
  rule_version   text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index content_rule_tenant_idx on content_diagnosis_rule(tenant_id);

create table content_question (
  question_id      text primary key,
  tenant_id        text not null,
  chapter_id       text not null,
  question_version integer not null default 1,
  stem_format      text not null,
  tags             text[] not null default '{}',
  measurement_dims text[] not null default '{}',
  published        boolean not null default false,
  payload          jsonb not null,
  created_at       timestamptz not null default now(),
  unique (question_id, question_version)
);
create index content_question_chapter_idx on content_question(tenant_id, chapter_id);
create index content_question_dims_idx on content_question using gin(measurement_dims);

-- 题图：与题干同事务写入（设计 §7.1），字节存 bytea
create table content_question_asset (
  asset_id            text primary key,
  tenant_id           text not null,
  question_id         text not null references content_question(question_id),
  role                text not null,
  image_bytes         bytea not null,
  mime_type           text not null,
  source_fragment_id  text references content_source_fragment(fragment_id),
  page_no             integer,
  bbox                double precision[],
  content_hash        text not null,
  created_at          timestamptz not null default now()
);
create index content_question_asset_q_idx on content_question_asset(question_id);

create table content_measurement_target (
  tenant_id      text not null,
  question_id    text not null references content_question(question_id),
  dim            text not null,
  role           text not null check (role in ('primary','secondary','prerequisite')),
  evidence_rule  text not null,
  primary key (question_id, dim)
);

create table content_chapter_package (
  package_id      text primary key,
  tenant_id       text not null,
  version         text not null,
  manifest_hash   text not null unique,
  published_by    text not null references identity_user(user_id),
  published_at    timestamptz,
  withdrawn_at    timestamptz,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (tenant_id, version)
);

-- 字段级血缘（设计 §7.3）：每个正式语义字段一行
create table content_field_lineage (
  lineage_id          bigint generated always as identity primary key,
  tenant_id           text not null,
  package_version     text,
  entity_type         text not null,
  entity_id           text not null,
  field_path          text not null,
  source_fragment_id  text references content_source_fragment(fragment_id),
  source_span_or_bbox text,
  derivation_type     text not null,
  provenance_status   text not null check (provenance_status in ('direct','derived','model_generated','human_authored')),
  agent_run_id        text,
  prompt_version      text,
  model_id            text,
  tool_call_ids       text[],
  reviewer_id         text references identity_user(user_id),
  review_decision     text check (review_decision in ('confirmed','modified','rejected','merged','pending')),
  confidence          double precision check (confidence between 0 and 1),
  created_at          timestamptz not null default now()
);
create index content_field_lineage_entity_idx on content_field_lineage(entity_type, entity_id);
create index content_field_lineage_tenant_idx on content_field_lineage(tenant_id);

insert into infra_schema_migration(version) values ('0002_content');
commit;
