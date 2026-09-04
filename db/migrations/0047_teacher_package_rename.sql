-- 0047: 练习包/批次显示名支持重命名。
-- content_package.title 允许教师改名（origin='teacher' 且仅改 title），
-- 其余包身份字段仍不可变；content_candidate_set.display_name 见 0046。
begin;

create or replace function mathpilot_package_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'content package is immutable'; end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.origin is distinct from old.origin
     or new.owner_teacher_user_id is distinct from old.owner_teacher_user_id
     or new.version_no is distinct from old.version_no
     or new.manifest_object_id is distinct from old.manifest_object_id
     or new.manifest_sha256 is distinct from old.manifest_sha256
     or new.approved_er_candidate_set_id is distinct from old.approved_er_candidate_set_id
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

-- 仅重载函数体；触发器保留原有名称与关联，无需重建。
-- 若既有触发器缺失则重建以保证一致性。
drop trigger if exists content_package_guard on content_package;
create trigger content_package_guard before update or delete on content_package
  for each row execute function mathpilot_package_guard();

insert into infra_schema_migration(version) values ('0047_teacher_package_rename') on conflict (version) do nothing;
commit;
