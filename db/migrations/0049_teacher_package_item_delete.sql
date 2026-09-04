-- 0049: content_package_item 删除守卫修正。
-- 通用 forbid_mutation 会拦截“删除教师未发布包”的级联删除；
-- 替换为专用守卫，仅允许随教师 ready 包整体删除 item，其余 update/delete 仍禁止。
begin;

create or replace function mathpilot_package_item_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from content_package p
                where p.package_id = old.package_id
                  and p.origin = 'teacher' and p.status = 'ready') then
      return old;
    end if;
    raise exception 'content package item is immutable';
  end if;
  raise exception 'content package item is immutable';
end
$$;

drop trigger if exists content_package_item_immutable on content_package_item;
create trigger content_package_item_immutable before update or delete on content_package_item
  for each row execute function mathpilot_package_item_guard();

insert into infra_schema_migration(version) values ('0049_teacher_package_item_delete') on conflict (version) do nothing;
commit;
