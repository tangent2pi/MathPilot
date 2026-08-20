# ADR-002：仓库布局与契约目录

- 状态：已接受（v1.2：2026-08-20 修订——移除旧前端与未接入部署占位）
- 日期：2026-08-17
- 依据：`系统设计v3.3` §2.4、`进一步实施规划v1` §3、§9

## 背景

系统边界多、角色隔离要求强、供应链约束严，仓库布局必须让每个模块能独立替换且不共享私有结构。

## 决策

遵循设计文档 §2.4 布局（`apps/`、`services/`、`packages/` 位于 `src/` 之下；`db/`、`deploy/`、`tests/`、`docs/`、`architecture/` 保持仓库根）：

```text
src/
  apps/
    web/                 # 唯一正式前端
  services/
    api/                 # 统一 HTTP 网关、认证与领域授权
    agent-runtime/       # Pi SDK/RPC 适配、Session 编排、沙箱 Broker
    content/             # OCR、KTQ/ER、复核、发布
    learning/            # 单题 Session、模型主判、教学
    profile/             # 双产物、EvidenceBundle、Decision 校验、快照
    review/              # 教师复核、supersede、重放
  packages/
    contracts/           # JSON Schema、OpenAPI、Provider 接口、事件名
    providers/           # model / ocr 宿主侧实现；其余能力由运行时装配
    mastery/             # 程序科学评价（BKT/保持率/错因统计）
db/
  migrations/          # PostgreSQL 迁移（含 RLS、函数与权限）
deploy/
  dev/                 # 唯一 Compose 组合根（全服务 + PostgreSQL）
tests/
  e2e/                 # 学生/教师/内容/画像四类流程
docs/
  数据整理说明.md       # 结构化数据来源与导出说明
architecture/
  decisions/           # 本目录（ADR）
  glossary.md          # 统一术语表
```

## 后果

- `references/` 仅只读参考（已在 `.gitignore`），任何实现不得直接 import。
- 服务间禁止共享 PostgreSQL 私有表结构；只交换版本化契约对象与事件。
- 前端不持有模型密钥、不直连数据库。
