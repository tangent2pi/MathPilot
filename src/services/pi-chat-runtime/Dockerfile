# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ENV NODE_ENV=production

# 固定使用仓库中已审计的 Qwen-MM-Plugins 副本；镜像构建不联网拉另一份源码。
COPY references/qwen-mm-plugins /opt/qwen-mm-plugins-src

# Pi 文件工具与 Core/Search/OCR 全部由官方 Sandbox Runtime 启动。
# bubblewrap/socat 是该运行时在 Linux 上的依赖，不在项目中手写参数。
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash bubblewrap ca-certificates ffmpeg findutils gawk jq \
      libreoffice-impress libreoffice-writer fonts-noto-cjk \
      poppler-utils python3 python3-numpy python3-pypdf2 python3-scipy \
      python3-sympy python3-venv qpdf ripgrep socat util-linux xxd && \
    python3 -m venv /opt/qwen-mm && \
    /opt/qwen-mm/bin/pip install --no-cache-dir '/opt/qwen-mm-plugins-src[core,search]' && \
    python3 -m venv /opt/paddleocr-mcp && \
    /opt/paddleocr-mcp/bin/pip install --no-cache-dir 'paddleocr-mcp==0.8.5' && \
    mkdir -p /tmp/qwen-mm-search && chmod 1777 /tmp/qwen-mm-search && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY src/packages/internal-service/package.json ./src/packages/internal-service/package.json
COPY src/services/pi-chat-runtime/package.json ./src/services/pi-chat-runtime/package.json
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts --filter @mathpilot/pi-chat-runtime... && \
    corepack pnpm --filter @mathpilot/pi-chat-runtime rebuild esbuild

# Copy only the new Pi runtime. Legacy services, local agent state and .env
# files never enter this image, so the model cannot discover an old runtime.
COPY src/packages/internal-service ./src/packages/internal-service
COPY src/services/pi-chat-runtime ./src/services/pi-chat-runtime

EXPOSE 3105
CMD ["corepack", "pnpm", "--filter", "@mathpilot/pi-chat-runtime", "start"]
