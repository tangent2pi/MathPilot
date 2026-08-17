-- 0001: 迁移版本表、身份族
begin;

create table infra_schema_migration (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

create table identity_tenant (
  tenant_id   text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 领域用户：只做 OIDC sub → 领域主体映射（ADR：认证归 Keycloak）
create table identity_user (
  user_id       text primary key,
  tenant_id     text not null references identity_tenant(tenant_id),
  oidc_sub      text not null unique,
  display_name  text,
  roles         text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index identity_user_tenant_idx on identity_user(tenant_id);

create table identity_class (
  class_id    text primary key,
  tenant_id   text not null references identity_tenant(tenant_id),
  name        text not null,
  teacher_id  text not null references identity_user(user_id),
  created_at  timestamptz not null default now()
);
create index identity_class_tenant_idx on identity_class(tenant_id);

create table identity_class_member (
  tenant_id   text not null,
  class_id    text not null references identity_class(class_id),
  student_id  text not null references identity_user(user_id),
  created_at  timestamptz not null default now(),
  primary key (class_id, student_id)
);
create index identity_class_member_tenant_idx on identity_class_member(tenant_id);

insert into infra_schema_migration(version) values ('0001_identity');
commit;
