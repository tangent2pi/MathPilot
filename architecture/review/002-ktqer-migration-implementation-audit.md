# KTQ/ER 对话式 Skill 管线迁移实现审计

日期：2026-08-30

本文与 `design-docs/KTQER对话式Skill管线迁移设计v1.md` 配套。它记录已经落地的
低风险边界和仍需产品/数据确认的迁移，不把旧 `agent-runtime` 的内容管线误称为新
Pi 对话架构。

## 已落地

- `mathpilot_pi` 新增 `0003_pi_threads_user_owner.sql`、`0004_pi_card_events_actor.sql`
  和 `0005_pi_attachments.sql`。线程只按 `tenant_id + owner_user_id` 授权，事件记录
  `actor_user_id`；网关不再查询或转发 `x-accessible-student-ids`。
- Pi 宿主在每次用户回合前把受信主体写入工作区外的 host-only 状态目录。模型工具只能
  使用 `content_library_search` / `content_library_get` 的受限参数，内容服务再按主体
  做可见性查询。
- KTQ、ER、OCR 和内容库 Skill 已进入 `pi-chat-runtime/skills`，不再依赖旧
  `/opt/mathpilot-skills` 路径。`respond` 会核对结果路径、JSON Schema、回执哈希和最小
  结构约束；assistant-ui 已有对应复核卡入口。
- 现有 base64 上传暂时保持兼容，同时写入 `pi_attachments` 和 SHA-256；这不是最终的
  MinIO 直传实现。

## 有意未做的破坏性迁移

以下项目会影响旧 `content`、`learning`、`review` 服务或已有数据，当前没有擅自执行：

1. 删除/改写 `identity_class.teacher_id`、`identity_class_member`、
   `identity_teacher_student_binding`；
2. 把 `identity_user.roles` 收缩为只有 `teacher`/`student`；
3. 删除旧 `content_*` payload 表和旧 `/pipelines`、`/ktq/run`、`/er/run` 入口；
4. 将历史已发布内容判定为 official，或为无法追溯的实体猜测教师 owner；
5. 把 MinIO 直传 URL 的 host/CORS 暴露到浏览器；
6. 引入新的队列/数据库/服务进程。

## 建议的最小落地顺序

继续沿用一个主 PostgreSQL、一个 `mathpilot_pi` 和现有 MinIO，不新增数据库或队列：

1. 先提供官方内容清单与历史实体 owner 对账表；
2. 确认兼容期（旧服务继续读旧表，还是立即切换）；
3. 在主库追加规范化实体/修订/候选复核/包发布表，并做只读双写对账；
4. 用数据库 outbox/polling dispatcher 处理 ER handoff，确认无误后才移除旧入口；
5. 明确浏览器可达的 MinIO/S3 endpoint 后，再切换 presigned PUT/GET 和对象版本校验。

## 需要确认的决策

请在继续主库迁移前明确下面四项：

| 编号 | 问题 | 推荐默认 |
|---|---|---|
| A | `guardian`、`content_reviewer`、`tenant_admin`、`platform_ops` 是否保留？ | 保留为通用 user-role；班级教学关系另限 `teacher`/`student` |
| B | 旧 class/binding 表是否允许一个发布周期的兼容读取？ | 允许；完成对账后再删除旧列/表 |
| C | 是否接受 DB outbox/polling 代替新增消息队列？ | 接受，不新增基础设施 |
| D | MinIO 对浏览器使用哪个可达 endpoint/CORS 域名？ | 由部署环境提供 `MINIO_PUBLIC_ENDPOINT`，缺失时继续同源代理 |

在 A–D 和历史 owner 对账未确认前，删除旧表或自动发布 official 内容都不可逆，故本次
只提交上述可回滚边界与适配层。
