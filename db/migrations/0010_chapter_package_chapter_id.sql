-- 0010: P0 修复 1——章节包绑定章节 + OCR storage_ref 可空 + 复核任务 cancelled 状态
-- 1) content_chapter_package.chapter_id：证明"题目属于哪个发布版本"的证据链（P0-5）；
--    版本唯一性改为按 (tenant_id, chapter_id, version) 生效。
-- 2) content_source_document.storage_ref 可空：字节未持久化（bytes_persisted:false）时
--    不得伪造对象存储引用（P1 OCR）。
-- 3) review_review_task 增加 cancelled：内容管线"先注册复核任务、后提交 staging"模式下，
--    事务失败时的补偿清理（P0-4）。
begin;

alter table content_chapter_package add column chapter_id text;
-- 回填：从既有包 manifest 的 questions 反查题目章节（新库无题目数据时保持 NULL，由服务写入）
update content_chapter_package p
   set chapter_id = q.chapter_id
  from content_question q
 where p.chapter_id is null
   and q.question_id = any(
     (select array(select jsonb_array_elements_text(p.payload->'contents'->'questions')))::text[]
   );

-- 版本唯一性按章节生效；旧行（chapter_id 为 NULL）不互相冲突（PG 唯一索引对 NULL 去重）
alter table content_chapter_package drop constraint if exists content_chapter_package_tenant_id_version_key;
create unique index content_chapter_package_chapter_version_idx
  on content_chapter_package(tenant_id, chapter_id, version);

alter table content_source_document alter column storage_ref drop not null;

alter table review_review_task drop constraint if exists review_review_task_status_check;
alter table review_review_task add constraint review_review_task_status_check
  check (status in ('pending','confirmed','modified','rejected','merged','cancelled'));

insert into infra_schema_migration(version) values ('0010_chapter_package_chapter_id');
commit;
