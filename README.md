# 数学智元（MathPilot）

面向高中数学的诊断教学系统：学生通过对话练习、测评并查看学习记录；教师导入与复核
K/T/Q/E/R 内容、管理题库和组卷。学习后台使用 Temporal 编排任务、科学内核与 Dream 画像。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `src/apps/web-next/` | 唯一前端；`public/defense/` 保存线上答辩静态页及资源 |
| `src/services/api-next/` | Better Auth、账户与学习 HTTP 网关、授权及读模型 |
| `src/services/learning-next/` | 学习对话、测评工具、Temporal 工作流、科学内核与 Dream |
| `src/services/pi-chat-runtime/` | 教师资料对话、Pi 会话与沙箱能力 |
| `src/services/content-next/` | 内容候选、教师复核、题库、试卷和官方内容导入 |
| `src/services/storage-next/` | 私有对象管理与预签名上传下载 |
| `src/services/group-next/` | 试卷与答案 PDF 渲染 |
| `src/packages/` | contracts、content-integrity、internal-service、self-test、providers/ocr |
| `db/` | 主库迁移、`pi/` 线程库迁移、`migration-data/` 清单、`tools/` 数据转换 |
| `deploy/dev/` | 唯一 Compose 组合根及开发初始化 |
| `tests/e2e/` | 在线只读和容器沙箱冒烟；单元/集成测试随各 workspace 保存 |
| `docs/` | 当前开发、部署和数据操作说明 |
| `design-docs/`、`architecture/` | 产品设计、答辩原稿、架构决策与历史审计 |
| `competition-info/`、`data/` | 赛题原始资料、固定导入输入及派生快照 |
| `references/` | 忽略入库的参考源码和本地档案 |

`-next` 是现有 workspace、镜像与服务标识，当前目录均为正式实现。
PostgreSQL 保存业务事实；Pi JSONL/工作区与 MinIO 对象也需要独立备份，CSV 不是运行时事实源。

## 开发与验证

```sh
nix develop
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm contracts:validate
pnpm --filter @mathpilot/web-next build
```

数据库集成测试通过对应测试文件中声明的环境变量启用；未配置时会报告跳过。
在线验证见 [tests/e2e/README.md](tests/e2e/README.md)。

## 启动

在 `nix develop` 中从仓库根执行：

```sh
test -d references/qwen-mm-plugins/.git || git clone https://github.com/QwenLM/Qwen-MM-Plugins.git references/qwen-mm-plugins
git -C references/qwen-mm-plugins checkout dd029da3bcadfe497de4b4ca8976b11177997cf0
cd deploy/dev
test -f .env || cp .env.example .env
# 配置供应商密钥、数据库及内部服务参数后：
docker compose up -d --build
```

前端默认地址为 <http://localhost:8080>。完整配置见 [部署说明](deploy/dev/README.md)，
线上环境见 [home 部署](docs/home-next-deployment.md)，对话边界见 [Pi 开发说明](docs/pi-chat-development.md)。

## 资料与维护

- [目录约定](AGENTS.md)与[当前架构布局](architecture/decisions/ADR-002-repository-layout.md)
- [数据库迁移](db/README.md)与[数据整理说明](docs/数据整理说明.md)
- [答辩材料](design-docs/defense/README.md)
- [本次清理、线上同步和验证记录](docs/repository-maintenance.md)

提交源码、资源、迁移、环境模板和锁文件；密钥、会话导出、运行时数据、备份、依赖及
构建产物保持本地。过往设计与迁移保留原始语义，历史路径不代表当前部署入口。
