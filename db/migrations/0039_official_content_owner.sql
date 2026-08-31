-- 0039: bind the reviewed official snapshot to the configured default teacher.
--
-- This changes only normalized Next content. It does not inspect or migrate
-- legacy content tables. Existing official rows are assigned deterministically
-- to the tenant's explicit dev administrator (usr_teacher01) or first teacher.
begin;

do $$
begin
  if exists (
    select 1
      from (select distinct tenant_id from content_source where origin='official' and owner_teacher_user_id is null
            union select distinct tenant_id from content_entity where origin='official' and owner_teacher_user_id is null
            union select distinct tenant_id from content_package where origin='official' and owner_teacher_user_id is null) tenant
     where not exists (
       select 1 from identity_user_role role
        where role.tenant_id=tenant.tenant_id and role.role='teacher'
     )
  ) then
    raise exception 'official Next content cannot be assigned because its tenant has no teacher';
  end if;
end
$$;

alter table content_source disable trigger content_source_immutable;
alter table content_entity disable trigger content_entity_immutable;
alter table content_package disable trigger content_package_guard;

with default_owner as (
  select distinct on (role.tenant_id) role.tenant_id,role.user_id
    from identity_user_role role where role.role='teacher'
   order by role.tenant_id,(role.user_id='usr_teacher01') desc,role.user_id
)
update content_source source
   set owner_teacher_user_id=owner.user_id,
       uploaded_by_user_id=coalesce(source.uploaded_by_user_id,owner.user_id)
  from default_owner owner
 where source.tenant_id=owner.tenant_id
   and source.origin='official' and source.owner_teacher_user_id is null;

with default_owner as (
  select distinct on (role.tenant_id) role.tenant_id,role.user_id
    from identity_user_role role where role.role='teacher'
   order by role.tenant_id,(role.user_id='usr_teacher01') desc,role.user_id
)
update content_entity entity
   set owner_teacher_user_id=owner.user_id,
       created_by_user_id=coalesce(entity.created_by_user_id,owner.user_id)
  from default_owner owner
 where entity.tenant_id=owner.tenant_id
   and entity.origin='official' and entity.owner_teacher_user_id is null;

with default_owner as (
  select distinct on (role.tenant_id) role.tenant_id,role.user_id
    from identity_user_role role where role.role='teacher'
   order by role.tenant_id,(role.user_id='usr_teacher01') desc,role.user_id
)
update content_package package
   set owner_teacher_user_id=owner.user_id
  from default_owner owner
 where package.tenant_id=owner.tenant_id
   and package.origin='official' and package.owner_teacher_user_id is null;

alter table content_source enable trigger content_source_immutable;
alter table content_entity enable trigger content_entity_immutable;
alter table content_package enable trigger content_package_guard;

do $$
declare target regclass;
declare item record;
begin
  foreach target in array array['content_source'::regclass,'content_entity'::regclass,'content_package'::regclass] loop
    for item in
      select conname from pg_constraint
       where conrelid=target and contype='c'
         and pg_get_constraintdef(oid) like '%owner_teacher_user_id%'
    loop
      execute format('alter table %s drop constraint %I',target,item.conname);
    end loop;
  end loop;
end
$$;

alter table content_source
  add constraint content_source_owner_check check (owner_teacher_user_id is not null);
alter table content_entity
  add constraint content_entity_owner_check check (owner_teacher_user_id is not null);
alter table content_package
  add constraint content_package_owner_check check (
    owner_teacher_user_id is not null
    and ((origin='official' and approved_er_candidate_set_id is null)
      or (origin='teacher' and approved_er_candidate_set_id is not null))
  );

drop policy if exists content_package_teacher_write on content_package;
create policy content_package_teacher_write on content_package for all using (
  tenant_id=current_setting('app.current_tenant',true)
  and 'teacher'=any(string_to_array(coalesce(current_setting('app.current_roles',true),''),','))
  and owner_teacher_user_id=current_setting('app.current_user',true)
) with check (
  tenant_id=current_setting('app.current_tenant',true)
  and 'teacher'=any(string_to_array(coalesce(current_setting('app.current_roles',true),''),','))
  and owner_teacher_user_id=current_setting('app.current_user',true)
);

insert into infra_schema_migration(version) values ('0039_official_content_owner');
commit;
