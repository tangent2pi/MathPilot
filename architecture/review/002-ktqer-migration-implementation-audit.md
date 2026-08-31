# KTQ/ER 对话式 Skill 管线迁移实现审计

日期：2026-08-30

最终状态：2026-08-31 已按用户确认完成收敛。本文前半部分是实施前审计记录；下方“最终
决策与落地”覆盖原来的未决项和“有意未做”列表。

本文与 `design-docs/KTQER对话式Skill管线迁移设计v1.md` 配套。它记录已经落地的
低风险边界和仍需产品/数据确认的迁移，不把旧 `agent-runtime` 的内容管线误称为新
Pi 对话架构。

## 已落地

- `mathpilot_pi` 新增 `0003_pi_threads_user_owner.sql`、`0004_pi_card_events_actor.sql`
  和 `0005_pi_attachments.sql`。线程按 owner 或显式 ACL 授权、删除只认 owner，teacher
  没有全租户旁路；事件记录 `actor_user_id`，网关不再转发学生范围。
- Pi 宿主在每次用户回合前把受信主体写入工作区外的 host-only 状态目录。模型工具只能
  使用 `content_library_search` / `content_library_get` 的受限参数，内容服务再按主体
  做可见性查询。
- KTQ、ER、OCR 和内容库 Skill 已进入 `pi-chat-runtime/skills`；Core/Search/OCR 与其他
  扩展使用同一个 Pi `agentDir/extensions` 插件发现机制。`respond` 核对结果路径、Schema、
  回执哈希和最小结构约束，assistant-ui 提供复核卡入口。
- 新 Web 附件使用 MinIO 预签名直传/直下，并在服务端完成版本、大小、MIME 和 SHA-256
  复核；Pi 只根据稳定 `object_id` 物化当前线程的只读工作副本。

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
4. 用数据库 outbox/polling dispatcher 处理复核反馈与 ER handoff，确认无误后才移除旧入口；
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

## 最终决策与落地（2026-08-31）

| 原问题 | 最终决定 | 落地位置 |
|---|---|---|
| A 角色 | 只保留 `teacher`、`student`；退役标签不赋予 teacher | `0031_content_pipeline_cutover.sql`、`api-next/src/auth.ts` |
| B 兼容 | 不做旧表兼容和双写；旧服务源码不改，切换后手工清理旧入口表 | `db/cutover/` |
| C handoff | 使用主库记录 + 5 秒 polling/retry，不新增队列或数据库 | `content_review_decision`、`content_er_start_command`、`content-next` |
| D MinIO | public endpoint/CORS 都由环境变量提供；生产为 `mathpilot.tangentpi.com`，本地为 localhost | `storage-next`、`deploy/dev` |

官方初始库不从旧表猜测，而只导入已提取的五份 `data/*.csv` 清单，共 174 个固定修订；
来源、题图和字段血缘也使用独立 Next 表，没有给旧内容表追加兼容列。
无法追溯的历史 teacher-origin owner 使用该租户唯一 teacher；官方实体本身保持 ownerless。
此前误生成的六个纯增量迁移已合并为单次正式 `0031`，清理脚本只删除确认为空的残留对象。

Next 完整链路现为：assistant-ui 直传对象 → Pi 普通会话按需执行 KTQ → `respond` 校验并登记
候选 → 独立复核页 → 同事务 ER 命令 → 新普通 ER 会话 → 复核批准生成 ready 包 → 教师选择
班级发布。旧 `content` 与旧 `agent-runtime` 仍只服务旧链，未被错误改造成 Next 实现。
