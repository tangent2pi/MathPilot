# ADR-002：仓库布局与契约目录

- 状态：已接受（v1.1：2026-08-17 修订——TS 代码归拢至 `src/`）
- 日期：2026-08-17
- 依据：`系统设计v3.3` §2.4、`进一步实施规划v1` §3、§9

## 背景

系统边界多、角色隔离要求强、供应链约束严，仓库布局必须让每个模块能独立替换且不共享私有结构。

## 决策

遵循设计文档 §2.4 布局（v1.1 起 `apps/`、`services/`、`packages/` 位于 `src/` 之下；`db/`、`deploy/`、`tests/`、`evals/`、`docs/`、`architecture/` 保持仓库根）：

```text
src/
  apps/
    web-test/            # 首期流程验证前端
    web/                 # 后期正式前端（视觉专业模型接管）
  services/
    api/                 # OpenAPI + SSE/WebSocket 网关
    agent-runtime/       # Pi SDK/RPC 适配、Session 编排、沙箱 Broker
    content/             # OCR、KTQ/ER、复核、发布
    learning/            # 单题 Session、模型主判、教学
    artifact/            # ArtifactPublisher、交互事件
    profile/             # 双产物、EvidenceBundle、Decision 校验、快照
    review/              # 教师复核、supersede、重放
  packages/
    contracts/           # JSON Schema、OpenAPI、Provider 接口、事件名
    providers/           # model / ocr / search / media / explanation / sandbox / auth 实现
    mastery/             # 程序科学评价（BKT/保持率/错因统计）
    provenance/          # 血缘、版本、审计工具
    ui-sdk/              # 由 contracts 生成的 TS 客户端与类型
db/
  migrations/          # PostgreSQL 迁移（按 schema 版本管理）
  policies/            # RLS 策略、replica grants
deploy/
  dev/                 # compose 组合根（全服务 + postgres + keycloak + minio）
tests/
  contract/            # Provider 与服务契约测试
  e2e/                 # 学生/教师/内容/画像四类流程
evals/
  golden/              # 判答、画像、OCR、注入黄金集
docs/
  runbooks/            # 部署、密钥、备份、回退、安全事件手册
architecture/
  decisions/           # 本目录（ADR）
  glossary.md          # 统一术语表
```

## 后果

- `references/` 仅只读参考（已在 `.gitignore`），任何实现不得直接 import。
- 服务间禁止共享 PostgreSQL 私有表结构；只交换版本化契约对象与事件。
- 前端不持有模型密钥、不直连数据库。