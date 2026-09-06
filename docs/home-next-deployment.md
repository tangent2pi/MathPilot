# home 当前部署

部署根为 `/srv/stacks/mathpilot-next`，唯一组合根为 `deploy/dev/compose.yaml`。
当前分支为 `next-teammate`。2026-09-06 核对时，home Git HEAD 为 `aa202d6`，
工作区应用改动与本地清理前提交 `09f5c3c` 内容一致；本地额外保有回归测试。
Pi 运行容器内 `extensions/sandbox.ts` 仍是未接收显式 cwd 的旧版本；已下载存档，
保留本地较新的实现，不用旧镜像覆盖源码。下一次计划部署时应重建 Pi 镜像。

## 源码与数据边界

- 后端使用仓库源码 bind mount；依赖或 Dockerfile 改动需重建相应镜像。
- Web 将 `deploy/dev/web-dist` 挂载到 `/usr/share/nginx/html`，构建输出为
  `src/apps/web-next/dist`。Nginx 模板来源为 `src/apps/web-next/nginx.conf`。
- `/defense/` 已从 home 同步到 `src/apps/web-next/public/defense/`，以后随 Web 构建
  一起输出。更新线上产物前先检查 `dist/defense/index.html` 和附件。
- 主库/Pi 库、Pi JSONL/工作区、学习运行时卷、MinIO 卷与 `.env` 均为部署数据，
  不入 Git，也不通过源码同步覆盖。
- 旧卷 `mathpilot_pgdata` 和历史工作区仍保留；当前使用 `mathpilot_pgdata_next`。

## 配置

参数见 `deploy/dev/.env.example`，供应商地址与模型 ID 显式配置。
生产 `MINIO_PUBLIC_ENDPOINT=https://mathpilot.tangentpi.com`；Nginx 将对象请求同域
转发至 MinIO，保留签名 Host/原始 URI。`storage-next` 必须配置四条接收 edge 的 keyring，
包括 `MATHPILOT_INTERNAL_CONTENT_TO_STORAGE_KEYRING`。

## 验证与历史

在目标部署根执行 `docker compose -f deploy/dev/compose.yaml config --quiet` 和
`docker compose -f deploy/dev/compose.yaml ps`；只读 API 冒烟见 `tests/e2e/README.md`。
Docker 权限以目标主机配置为准，home 当前通过 `sudo -n docker` 读取状态。

本次同步只读取 home 并恢复本地文件，没有重启、更新或迁移线上服务。
首次部署和历史切换步骤见[历史记录](../architecture/review/003-home-first-cutover.md)，
不要将其中旧路径直接用于当前部署。
