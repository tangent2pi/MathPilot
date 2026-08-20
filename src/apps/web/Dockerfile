# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=agmath-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild && corepack pnpm --filter @mathpilot/web build

FROM nginx:1.27-alpine
COPY src/apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/src/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/node_modules/.pnpm/lxgw-wenkai-webfont@1.7.0/node_modules/lxgw-wenkai-webfont /usr/share/nginx/html/fonts/lxgw-wenkai
EXPOSE 80
