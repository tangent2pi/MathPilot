# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild
EXPOSE 3101
CMD ["corepack", "pnpm", "--filter", "@mathpilot/api-next", "start"]
