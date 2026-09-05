-- Register one deterministic retention unit per approved content dimension and
-- bind each question measurement target to it. This is the missing input edge
-- between normalized content and the delayed-review/FSRS projector.
begin;

create or replace function mathpilot_register_retention_measurement_target(
  p_tenant_id text,
  p_question_revision_id text,
  p_measurement_rule_id text,
  p_dimension_revision_id text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  unit_id text := 'rurev_' || md5(p_tenant_id || ':' || p_dimension_revision_id);
begin
  insert into public.science_v3_retention_unit_revision(
    retention_unit_revision_id,tenant_id,dimension_revision_id,scope_facets,definition_version
  ) values (
    unit_id,p_tenant_id,p_dimension_revision_id,
    jsonb_build_object('granularity','dimension','registration','automatic-v1'),1
  ) on conflict (tenant_id,retention_unit_revision_id) do nothing;

  insert into public.science_v3_retention_unit_measurement_rule(
    tenant_id,question_revision_id,measurement_rule_id,retention_unit_revision_id
  ) values (p_tenant_id,p_question_revision_id,p_measurement_rule_id,unit_id)
  on conflict (tenant_id,question_revision_id,measurement_rule_id) do nothing;
end
$$;

create or replace function mathpilot_register_retention_target_on_insert()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare question_revision text;
begin
  select item.revision_id into question_revision
    from public.content_revision_item item
    join public.content_entity_revision revision
      on revision.tenant_id=item.tenant_id and revision.revision_id=item.revision_id
    join public.content_question_revision question
      on question.tenant_id=revision.tenant_id and question.revision_id=revision.revision_id
   where item.tenant_id=new.tenant_id and item.item_id=new.item_id
     and revision.lifecycle_status in ('approved','ready');
  if question_revision is not null then
    perform public.mathpilot_register_retention_measurement_target(
      new.tenant_id,question_revision,new.item_id,new.dimension_revision_id
    );
  end if;
  return new;
end
$$;

drop trigger if exists content_measurement_target_retention_registration
  on content_question_measurement_target;
create trigger content_measurement_target_retention_registration
after insert on content_question_measurement_target
for each row execute function mathpilot_register_retention_target_on_insert();

create or replace function mathpilot_register_retention_on_revision_ready()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare target record;
begin
  if new.lifecycle_status in ('approved','ready')
     and old.lifecycle_status is distinct from new.lifecycle_status then
    for target in
      select measurement.item_id,measurement.dimension_revision_id
        from public.content_revision_item item
        join public.content_question_measurement_target measurement
          on measurement.tenant_id=item.tenant_id and measurement.item_id=item.item_id
       where item.tenant_id=new.tenant_id and item.revision_id=new.revision_id
    loop
      perform public.mathpilot_register_retention_measurement_target(
        new.tenant_id,new.revision_id,target.item_id,target.dimension_revision_id
      );
    end loop;
  end if;
  return new;
end
$$;

drop trigger if exists content_revision_retention_registration on content_entity_revision;
create trigger content_revision_retention_registration
after update of lifecycle_status on content_entity_revision
for each row execute function mathpilot_register_retention_on_revision_ready();

do $$
declare target record;
begin
  for target in
    select item.tenant_id,item.revision_id,measurement.item_id,measurement.dimension_revision_id
      from public.content_revision_item item
      join public.content_question_measurement_target measurement
        on measurement.tenant_id=item.tenant_id and measurement.item_id=item.item_id
      join public.content_entity_revision revision
        on revision.tenant_id=item.tenant_id and revision.revision_id=item.revision_id
      join public.content_question_revision question
        on question.tenant_id=revision.tenant_id and question.revision_id=revision.revision_id
     where revision.lifecycle_status in ('approved','ready')
  loop
    perform public.mathpilot_register_retention_measurement_target(
      target.tenant_id,target.revision_id,target.item_id,target.dimension_revision_id
    );
  end loop;
end
$$;

revoke all on function mathpilot_register_retention_measurement_target(text,text,text,text) from public;
revoke all on function mathpilot_register_retention_target_on_insert() from public;
revoke all on function mathpilot_register_retention_on_revision_ready() from public;

insert into infra_schema_migration(version) values ('0064_retention_unit_registration');
commit;
