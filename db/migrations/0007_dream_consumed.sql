-- 0007: Dream 消费标记 + 处理元数据的列级可变性守卫
-- 事实层不可变纪律不变（设计 §1.3）；但 dream_consumed_at / replay_status 是"处理状态"，
-- 不是事实本身。用 forbid_mutation_except 允许白名单列更新，其余字段仍拒绝变更。
begin;

alter table runtime_session_learning_record
  add column dream_consumed_at timestamptz;

create index runtime_slr_unconsumed_idx
  on runtime_session_learning_record(tenant_id, student_id)
  where dream_consumed_at is null;

-- 除白名单列外整行不可变
create or replace function forbid_mutation_except() returns trigger as $$
declare
  n jsonb := to_jsonb(NEW);
  o jsonb := to_jsonb(OLD);
  col text;
begin
  foreach col in array TG_ARGV loop
    n := n - col;
    o := o - col;
  end loop;
  if n <> o then
    raise exception 'immutable table %: only columns [%] may change', TG_TABLE_NAME, array_to_string(TG_ARGV, ',');
  end if;
  return NEW;
end
$$ language plpgsql;

drop trigger forbid_mutation on runtime_session_learning_record;
create trigger slr_guard before update on runtime_session_learning_record
  for each row execute function forbid_mutation_except('dream_consumed_at');
create trigger slr_no_delete before delete on runtime_session_learning_record
  for each row execute function forbid_mutation();

drop trigger forbid_mutation on review_teacher_correction;
create trigger correction_guard before update on review_teacher_correction
  for each row execute function forbid_mutation_except('replay_status', 'replay_result_ref');
create trigger correction_no_delete before delete on review_teacher_correction
  for each row execute function forbid_mutation();

insert into infra_schema_migration(version) values ('0007_dream_consumed');
commit;
