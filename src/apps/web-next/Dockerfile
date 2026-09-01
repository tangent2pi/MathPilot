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
ENV MINIO_PUBLIC_ENDPOINT=http://localhost:9000 \
    MATHPILOT_API_RATE=30r/s \
    MATHPILOT_API_BURST=60
COPY src/apps/web-next/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/src/apps/web-next/dist /usr/share/nginx/html
EXPOSE 80
