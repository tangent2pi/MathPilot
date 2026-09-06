# ADR-002：仓库布局与契约目录

- 状态：已接受；2026-09-06 按当前正式服务更新。
- 原始决策日期：2026-08-17。

## 决策

应用、服务和共享包置于 `src/`；数据库迁移归 `db/`，部署组合归 `deploy/dev/`。

```text
src/
  apps/web-next/          # 唯一应用前端
    public/defense/       # 已上线答辩静态页及引用资源
  services/
    api-next/            # 认证、授权、HTTP 网关与学习读模型
    learning-next/       # 学习、Temporal、科学内核与 Dream
    pi-chat-runtime/     # 教师 Pi 对话、宿主能力与沙箱
    content-next/        # 内容导入、候选复核、题库与试卷
    storage-next/        # 私有对象控制面
    group-next/          # PDF 渲染
  packages/
    contracts/           # Schema、类型与协议错误
    content-integrity/   # 内容摘要与发布边界
    internal-service/    # 服务间认证和公共设施
    self-test/           # 测评共享领域实现
    providers/ocr/       # OCR 宿主适配
 db/                     # 主库 migrations/、线程库 pi/、清单 migration-data/、工具 tools/
 deploy/dev/             # 唯一 Compose 组合根
 tests/e2e/              # 在线/容器验证入口
 docs/                   # 当前开发、部署、数据操作说明
 design-docs/            # 产品规格、设计与答辩材料
 architecture/           # ADR、术语和历史审计
```

## 后果

- `-next` 标识仍被 workspace、Compose、内部服务协议和镜像引用，整理保持这些标识稳定。
- `references/` 仅作本地参考，不入库，不可由产品源码直接 import。
- 前端不持有模型密钥、不直连数据库；Pi 迁移由根入口 `pnpm db:migrate:pi` 执行。
- 临时浏览器探针、个别数据行修补及本地备份不属于开发组合根。
- 历史契约、SQL 迁移、赛题原始资料和只读需求档案按其追溯用途保存。
