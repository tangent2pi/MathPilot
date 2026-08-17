-- 0008: 审计修复
-- 1) infra_outbox 误设为完全不可变——outbox 模式必须推进 published_at（处理元数据）；
--    改为列级守卫：仅 published_at 可更新，事件事实仍不可变。
-- 2) SLR 修订链：教师纠正重放后需生成修订 SessionLearningRecord 进入 Dream 窗口
--    （验收门槛"教师纠正能触发完整重放且保留旧版本"）。原 unique(session_id/ser_id/tss_id)
--    禁止了修订记录；改为 (session_id, ser_id) 复合唯一 + supersedes 谱系列。
begin;

drop trigger forbid_mutation on infra_outbox;
create trigger outbox_guard before update on infra_outbox
  for each row execute function forbid_mutation_except('published_at');
create trigger outbox_no_delete before delete on infra_outbox
  for each row execute function forbid_mutation();

alter table runtime_session_learning_record
  add column supersedes text;

-- 撤销三个单列 unique（名字由 PG 自动生成，按目录动态定位以防命名漂移）
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'runtime_session_learning_record'::regclass
       and contype = 'u'
  loop
    execute format('alter table runtime_session_learning_record drop constraint %I', c);
  end loop;
end $$;

-- 每次重放产生新 ser_id，同 (session, ser) 不得重复封装
create unique index runtime_slr_session_ser_uidx
  on runtime_session_learning_record(session_id, ser_id);

insert into infra_schema_migration(version) values ('0008_outbox_guard_slr_revision');
commit;
