-- 0053: 允许级联删除草稿试卷的题目项。
-- 删除 content_paper 行时，on delete cascade 会删除 content_paper_item；
-- 但 item 守卫在级联时刻查询不到已删除的试卷行（paper_status 为 NULL），
-- 误判为“paper is missing”并阻断删除。修正：仅当试卷仍存在且非 draft 时锁定。
begin;

create or replace function mathpilot_paper_item_guard()
returns trigger language plpgsql as $$
declare paper_status text;
begin
  select p.status into paper_status from content_paper p
   where p.paper_id = (case when tg_op = 'DELETE' then old.paper_id else new.paper_id end)
   limit 1;
  -- 试卷缺失 = 正在级联删除草稿卷，允许随之删除题目项；
  -- 试卷存在但非 draft（finalized）时题目项不可变。
  if paper_status is not null and paper_status is distinct from 'draft' then
    raise exception 'content paper item is immutable (paper is %)', paper_status;
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

insert into infra_schema_migration(version) values ('0053_paper_item_guard_cascade_delete') on conflict (version) do nothing;
commit;
