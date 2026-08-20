-- 0011: 题图与知识点的可查询关联（同一图片字节只存 content_question_asset 一份）
begin;

create table content_knowledge_asset_link (
  tenant_id    text not null,
  dimension_id text not null references content_knowledge_component(dimension_id),
  asset_id     text not null references content_question_asset(asset_id),
  relation     text not null default 'illustrates'
    check (relation in ('illustrates','prerequisite_diagram','solution_diagram')),
  created_at   timestamptz not null default now(),
  primary key (dimension_id, asset_id)
);
create index content_knowledge_asset_link_asset_idx on content_knowledge_asset_link(asset_id);

alter table content_knowledge_asset_link enable row level security;
create policy tenant_isolation on content_knowledge_asset_link
  using (tenant_id = current_setting('app.current_tenant', true))
  with check (tenant_id = current_setting('app.current_tenant', true));

insert into infra_schema_migration(version) values ('0011_content_asset_links');
commit;
