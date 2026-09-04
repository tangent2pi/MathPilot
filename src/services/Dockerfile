# syntax=docker/dockerfile:1.7
# 共享服务镜像：Node 24 直接运行 TS（type stripping），pnpm workspace 安装。
# 用法（compose）：build: { context: ../.., dockerfile: src/services/Dockerfile, args: { SERVICE_NAME: content-next | storage-next | internal-service } }
# Debian/glibc 可直接使用 numpy、pandas、scikit-learn 的 manylinux wheel；避免 Alpine/musl
# 在 Python 次版本升级后退回耗时且脆弱的本地 C/C++ 编译。
FROM node:24-bookworm-slim
ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}
ENV NODE_ENV=production

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=mathpilot-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild

CMD exec corepack pnpm --filter @mathpilot/${SERVICE_NAME} run start