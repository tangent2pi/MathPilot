-- 0054: 组卷答案解析。
-- content_paper 新增答案 PDF 成品字段（与试卷 PDF 同规则：finalized 后首次落盘允许，之后锁定）；
-- 新增 content_paper_answer_item 存逐题答案/解析草稿（题库答案 + AI 补全 + 教师复核结果）。
begin;

alter table content_paper
  add column if not exists answer_pdf_object_id text references storage_object(object_id),
  add column if not exists answer_pdf_sha256 text check (answer_pdf_sha256 is null or answer_pdf_sha256 ~ '^[0-9a-f]{64}$');

create table if not exists content_paper_answer_item (
  paper_id      text not null references content_paper(paper_id) on delete cascade,
  tenant_id     text not null references identity_tenant(tenant_id),
  item_order    integer not null check (item_order >= 0),
  answer_text   text not null default '',
  analysis_text text not null default '',
  need_review   boolean not null default false,
  review_note   text,
  source        text not null default 'bank' check (source in ('bank', 'ai', 'teacher')),
  updated_at    timestamptz not null default now(),
  primary key (paper_id, item_order)
);
create index if not exists content_paper_answer_item_paper_idx
  on content_paper_answer_item (tenant_id, paper_id, item_order);

-- 租户/所有者隔离（复用 0050 的「启用并强制 RLS」模式）。
alter table content_paper_answer_item enable row level security;
alter table content_paper_answer_item force row level security;
drop policy if exists tenant_isolation on content_paper_answer_item;
drop policy if exists content_paper_answer_item_teacher_write on content_paper_answer_item;

create policy tenant_isolation on content_paper_answer_item for select using (
  tenant_id = current_setting('app.current_tenant', true)
);
create policy content_paper_answer_item_teacher_write on content_paper_answer_item for all using (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and exists (
    select 1 from content_paper p
     where p.paper_id = content_paper_answer_item.paper_id
       and p.owner_teacher_user_id = current_setting('app.current_user', true)
  )
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and exists (
    select 1 from content_paper p
     where p.paper_id = content_paper_answer_item.paper_id
       and p.owner_teacher_user_id = current_setting('app.current_user', true)
  )
);

-- 更新试卷守卫：答案解析 PDF 与试卷 PDF 同规则——finalized 后首次落盘允许，之后锁定。
create or replace function mathpilot_paper_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' then return old; end if;
    raise exception 'content paper is immutable after finalized';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.owner_teacher_user_id is distinct from old.owner_teacher_user_id
     or new.version_no is distinct from old.version_no
     or new.source is distinct from old.source
     or new.config_snapshot is distinct from old.config_snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'content paper identity is immutable';
  end if;
  if new.title is distinct from old.title
     and (new.title is null or length(btrim(new.title)) = 0) then
    raise exception 'content paper title must not be empty';
  end if;
  if (new.pdf_object_id is distinct from old.pdf_object_id
      or new.pdf_sha256 is distinct from old.pdf_sha256) then
    if old.status = 'finalized' and old.pdf_object_id is not null then
      raise exception 'content paper pdf is immutable after finalized';
    end if;
  end if;
  if (new.answer_pdf_object_id is distinct from old.answer_pdf_object_id
      or new.answer_pdf_sha256 is distinct from old.answer_pdf_sha256) then
    if old.status = 'finalized' and old.answer_pdf_object_id is not null then
      raise exception 'content paper answer pdf is immutable after finalized';
    end if;
  end if;
  if old.status = new.status or (old.status = 'draft' and new.status = 'finalized') then
    return new;
  end if;
  raise exception 'invalid content paper status transition % -> %', old.status, new.status;
end
$$;

insert into infra_schema_migration(version) values ('0054_paper_answer') on conflict (version) do nothing;
commit;
