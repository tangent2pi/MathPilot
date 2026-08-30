# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ENV NODE_ENV=production

# Pi 的 Bash/Read/Write/Edit 通过官方 sandbox-runtime 在 Linux 上调用
# bubblewrap；socat 是该运行时的网络隔离依赖，xxd 用于图片类型探测。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash bubblewrap ca-certificates findutils jq python3 python3-sympy \
      ripgrep socat xxd && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild

EXPOSE 3105
CMD ["corepack", "pnpm", "--filter", "@mathpilot/pi-chat-runtime", "start"]
