-- 0050: 教师「我的试卷」结构化试卷（手动选题通道起步，upload 通道后续复用同表）。
--
-- content_paper 是一张独立试卷实体，与 content_package（练习包）区分：
--   · 定稿后内容不可变；题目难度/换题/重新生成仅在 draft 状态可变；
--   · 版本迭代 = 新建 version_no+1 的 draft 行，复制标题+配置+题目，供再次换题；
--   · 不参与班级发布/学生在线作答（线下打印 PDF）；
--   · PDF 成品存 storage_object（purpose='paper'），可随时重出。
begin;

-- 扩展 storage_object 用途，允许存放试卷 PDF。
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'storage_object_purpose_check'
       and conrelid = 'storage_object'::regclass
  ) then
    alter table storage_object drop constraint storage_object_purpose_check;
  end if;
end
$$;
alter table storage_object
  add constraint storage_object_purpose_check
  check (purpose in ('source', 'candidate', 'package', 'thread', 'derived', 'paper'));

create table if not exists content_paper (
  paper_id                text primary key,
  tenant_id               text not null references identity_tenant(tenant_id),
  owner_teacher_user_id   text references identity_user(user_id),
  title                   text not null,
  version_no              integer not null check (version_no > 0),
  status                  text not null default 'draft' check (status in ('draft', 'finalized')),
  source                  text not null default 'manual' check (source in ('manual', 'upload')),
  config_snapshot         jsonb not null,
  pdf_object_id           text references storage_object(object_id),
  pdf_sha256              text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz not null default now(),
  finalized_at            timestamptz,
  check (
    jsonb_typeof(config_snapshot) = 'object'
    and (config_snapshot ? 'counts') and (config_snapshot ? 'difficulty_ratio')
  )
);
create unique index if not exists content_paper_owner_version_idx
  on content_paper (tenant_id, owner_teacher_user_id, version_no);
create index if not exists content_paper_owner_created_idx
  on content_paper (tenant_id, owner_teacher_user_id, status, created_at desc);

create table if not exists content_paper_item (
  tenant_id   text not null references identity_tenant(tenant_id),
  paper_id    text not null references content_paper(paper_id) on delete cascade,
  entity_id   text not null references content_entity(entity_id),
  revision_id text not null references content_entity_revision(revision_id),
  item_order  integer not null check (item_order >= 0),
  difficulty  double precision check (difficulty is null or (difficulty between 0 and 1)),
  primary key (paper_id, item_order)
);
create index if not exists content_paper_item_paper_idx
  on content_paper_item (tenant_id, paper_id, item_order);

-- 回复草图：复用 0031 的「启用并强制 RLS」模式，为试卷表建租户/所有者隔离策略。
alter table content_paper enable row level security;
alter table content_paper force row level security;
alter table content_paper_item enable row level security;
alter table content_paper_item force row level security;
drop policy if exists tenant_isolation on content_paper;
drop policy if exists tenant_isolation on content_paper_item;

create policy tenant_isolation on content_paper for select using (
  tenant_id = current_setting('app.current_tenant', true)
);
create policy content_paper_teacher_write on content_paper for all using (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and owner_teacher_user_id = current_setting('app.current_user', true)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and 'teacher' = any(string_to_array(coalesce(current_setting('app.current_roles', true), ''), ','))
  and owner_teacher_user_id = current_setting('app.current_user', true)
);
create policy tenant_isolation on content_paper_item using (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_paper p where p.paper_id = content_paper_item.paper_id)
) with check (
  tenant_id = current_setting('app.current_tenant', true)
  and exists (select 1 from content_paper p where p.paper_id = content_paper_item.paper_id)
);

-- 试卷守卫：身份不可变；draft 允许改 title/换题/改难度/reset pdf；finalized 后内容与 pdf 均锁定。
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
    if old.status = 'finalized' then
      raise exception 'content paper pdf is immutable after finalized';
    end if;
  end if;
  if old.status = new.status or (old.status = 'draft' and new.status = 'finalized') then
    return new;
  end if;
  raise exception 'invalid content paper status transition % -> %', old.status, new.status;
end
$$;
drop trigger if exists content_paper_guard on content_paper;
create trigger content_paper_guard before update or delete on content_paper
  for each row execute function mathpilot_paper_guard();

-- 试卷题目项：仅所属试卷处于 draft 时允许增删改；finalized 后某一题项不再可变。
create or replace function mathpilot_paper_item_guard()
returns trigger language plpgsql as $$
declare paper_status text;
begin
  select p.status into paper_status from content_paper p
   where p.paper_id = (case when tg_op = 'DELETE' then old.paper_id else new.paper_id end)
   limit 1;
  if paper_status is distinct from 'draft' then
    raise exception 'content paper item is immutable (paper is %)', coalesce(paper_status, 'missing');
  end if;
  if tg_op = 'UPDATE' then
    if new.entity_id is distinct from old.entity_id
       or new.item_order is distinct from old.item_order then
      raise exception 'content paper item identity is immutable; replace revision or difficulty only';
    end if;
  end if;
  return coalesce(new, old);
end
$$;
drop trigger if exists content_paper_item_guard on content_paper_item;
create trigger content_paper_item_guard before insert or update or delete on content_paper_item
  for each row execute function mathpilot_paper_item_guard();

insert into infra_schema_migration(version) values ('0050_teacher_papers') on conflict (version) do nothing;
commit;