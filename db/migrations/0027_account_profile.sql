begin;

alter table "user" add column "phone" text;

create table identity_user_avatar (
  auth_user_id text primary key references "user"("id") on delete cascade,
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  image_bytes bytea not null,
  updated_at timestamptz not null default now(),
  check (octet_length(image_bytes) between 1 and 1572864)
);

insert into infra_schema_migration(version) values ('0027_account_profile');
commit;
