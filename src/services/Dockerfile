# syntax=docker/dockerfile:1.7
# 共享服务镜像：Node 24 + tsx 运行 TS，pnpm workspace 安装。
# 用法（compose）：build: { context: ../.., dockerfile: src/services/Dockerfile, args: { SERVICE_NAME: content-next | storage-next } }
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
