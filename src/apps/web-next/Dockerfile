# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild && \
    corepack pnpm --filter @mathpilot/web-next build

FROM nginx:1.27-alpine
COPY src/apps/web-next/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/src/apps/web-next/dist /usr/share/nginx/html
EXPOSE 80
