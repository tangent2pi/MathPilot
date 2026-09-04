-- 0048: 手动选题组卷（teacher 自选题目建包并发布到班级）。
-- content_package 新增 manual_build 形态：origin='teacher' 且 manual_build=true 时，
-- 无需绑定 approved_er_candidate_set_id；包 items 由教师挑选的题目 revision 组成。
begin;

alter table content_package
  add column if not exists manual_build boolean not null default false;

-- 放宽 teacher 包约束：manual 包允许 approved_er_candidate_set_id 为空。
alter table content_package
  drop constraint if exists content_package_owner_check;
alter table content_package
  add constraint content_package_owner_check check (
    owner_teacher_user_id is not null
    and ((origin='official' and approved_er_candidate_set_id is null and not manual_build)
      or (origin='teacher' and approved_er_candidate_set_id is not null and not manual_build)
      or (origin='teacher' and manual_build))
  );

-- manual_build 属于包身份字段：除 title（教师可改）外保持不可变。
-- 同时修正 0031 引入的 guard：DELETE 仅允许删除教师“未发布 ready”包
-- （deleteTeacherPackage 语义），已发布/官方包仍不可删除。
create or replace function mathpilot_package_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.origin = 'teacher' and old.status = 'ready' then return old; end if;
    raise exception 'content package is immutable';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.origin is distinct from old.origin
     or new.owner_teacher_user_id is distinct from old.owner_teacher_user_id
     or new.version_no is distinct from old.version_no
     or new.manifest_object_id is distinct from old.manifest_object_id
     or new.manifest_sha256 is distinct from old.manifest_sha256
     or new.approved_er_candidate_set_id is distinct from old.approved_er_candidate_set_id
     or new.manual_build is distinct from old.manual_build
     or new.created_at is distinct from old.created_at then
    raise exception 'content package identity is immutable';
  end if;
  -- 教师自建包允许改显示名 title；官方包不允许改 title。
  if new.title is distinct from old.title
     and (old.origin <> 'teacher' or new.title is null or length(btrim(new.title)) = 0) then
    raise exception 'content package title is immutable for this origin';
  end if;
  if old.status = new.status or (old.status = 'ready' and new.status in ('published', 'withdrawn')) then return new; end if;
  raise exception 'invalid content package status transition % -> %', old.status, new.status;
end
$$;

drop trigger if exists content_package_guard on content_package;
create trigger content_package_guard before update or delete on content_package
  for each row execute function mathpilot_package_guard();

-- content_package_item 原使用通用 forbid_mutation（任何 update/delete 都禁止），
-- 会拦截“删除教师未发布包”时的级联删除。替换为专用守卫：
-- 仅允许删除“所属包为教师 ready 包”的 item（配合包整体删除语义），
-- 其余 update/delete 依旧禁止。
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

insert into infra_schema_migration(version) values ('0048_teacher_manual_package') on conflict (version) do nothing;
commit;
