-- 0041: 学生"删除对话"采用软删除。
-- science_v3 全库按"不可变/防篡改学习证据日志"设计：conversation_thread、
-- question_session、canonical_message、foreground_request 等表均挂 guard 触发器
-- 禁止 DELETE（0033/0038），线程状态也仅有 active/archived。
-- 因此"永久删除对话"的语义落地为：置 deleted_at，并从所有读取路径
-- （列表/详情/选题/工作区投影）隐藏该对话；底层学习证据按设计保留，
-- 以支撑 BKT 熟练度与画像的科学证据链。
begin;

alter table science_v3_conversation_thread
  add column deleted_at timestamptz;

comment on column science_v3_conversation_thread.deleted_at is
  '软删除时间；非空表示该对话已从所有学生界面/入口永久移除（底层学习证据按架构设计保留）';

create index science_v3_conversation_thread_visible_idx
  on science_v3_conversation_thread(tenant_id, student_id, updated_at desc)
  where deleted_at is null;

insert into infra_schema_migration(version) values ('0041_conversation_thread_deleted_at');
commit;
