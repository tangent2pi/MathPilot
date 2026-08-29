-- 每个 Better Auth 账户拥有独立、稳定且不可复用的公开 UID。
-- 认证表内部 id 保持 Better Auth 所有，避免破坏现有 session/account 外键。
begin;

alter table "user" add column if not exists uid uuid;
update "user" set uid = gen_random_uuid() where uid is null;
alter table "user" alter column uid set default gen_random_uuid();
alter table "user" alter column uid set not null;
create unique index if not exists user_uid_unique_idx on "user" (uid);

insert into infra_schema_migration(version) values ('0030_account_uid')
on conflict (version) do nothing;

commit;
