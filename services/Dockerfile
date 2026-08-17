# 共享服务镜像：Node 24 直接运行 TS（type stripping），pnpm workspace 安装。
# 用法（compose）：build: { context: ../.., dockerfile: services/Dockerfile, args: { SERVICE_NAME: learning } }
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN corepack enable && corepack pnpm install --frozen-lockfile --ignore-scripts
ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}
ENV NODE_ENV=production
CMD corepack pnpm --filter @agmath/${SERVICE_NAME} run start
