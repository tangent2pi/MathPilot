-- A paper may be deleted by its owner regardless of publication state.
-- All UPDATE immutability rules remain unchanged.
begin;

create or replace function mathpilot_paper_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    return old;
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
    if old.status = 'finalized' and old.pdf_object_id is not null then
      raise exception 'content paper pdf is immutable after finalized';
    end if;
  end if;
  if (new.answer_pdf_object_id is distinct from old.answer_pdf_object_id
      or new.answer_pdf_sha256 is distinct from old.answer_pdf_sha256) then
    if old.status = 'finalized' and old.answer_pdf_object_id is not null then
      raise exception 'content paper answer pdf is immutable after finalized';
    end if;
  end if;
  if old.status = new.status or (old.status = 'draft' and new.status = 'finalized') then
    return new;
  end if;
  raise exception 'invalid content paper status transition % -> %', old.status, new.status;
end
$$;

insert into infra_schema_migration(version) values ('0062_paper_delete_finalized');
commit;
