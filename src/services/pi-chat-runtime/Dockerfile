# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ENV NODE_ENV=production
# apt 源换成阿里云镜像(http:基础镜像无 ca-certificates,https 会证书校验失败;apt 靠 keyring 校验签名)。
# pip 走阿里云源(实测清华/中科大 TLS 超时不可达,阿里云可正常 build-isolation 装 setuptools>=77)。
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PIP_TRUSTED_HOST=mirrors.aliyun.com
ENV PIP_DEFAULT_TIMEOUT=180

# 固定使用仓库中已审计的 Qwen-MM-Plugins 副本；镜像构建不联网拉另一份源码。
COPY references/qwen-mm-plugins /opt/qwen-mm-plugins-src
# paddleocr-mcp 从 PIP_INDEX_URL（阿里云镜像）在线安装；不需要本机预下载的 wheelhouse 闭包。

# Pi 文件工具与 Core/Search/OCR 全部由官方 Sandbox Runtime 启动。
# bubblewrap/socat 是该运行时在 Linux 上的依赖,不在项目中手写参数。
# Docker Desktop 会把 ~/.docker/config.json 里的 127.0.0.1:7897 代理注入构建容器,
# 容器内连不上宿主机代理,apt/pip/pnpm 会全部失败;故每个网络 RUN 先清掉这些变量,直连国内源。
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ftp_proxy all_proxy ALL_PROXY; \
    export no_proxy="*" NO_PROXY="*"; \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    apt_install() { local i; apt-get update -q || return 1; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do apt-get install -y -o Acquire::Retries=5 -o Acquire::http::Timeout=120 --no-install-recommends --download-only "$@" && break; echo "apt download retry $i"; done; apt-get install -y -o Acquire::Retries=3 --no-install-recommends "$@"; }; \
    apt_install \
      bash bubblewrap ca-certificates ffmpeg findutils gawk jq \
      libreoffice-impress libreoffice-writer fonts-noto-cjk \
      poppler-utils python3 python3-numpy python3-pypdf2 python3-scipy \
      python3-sympy python3-venv qpdf ripgrep socat util-linux xxd && \
    rm -rf /var/lib/apt/lists/*

# Python venv 与插件安装拆到独立层,后续只调 pip 源/依赖时不用重跑上面的 apt。
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ftp_proxy all_proxy ALL_PROXY; \
    export no_proxy="*" NO_PROXY="*"; \
    python3 -m venv /opt/qwen-mm && \
    /opt/qwen-mm/bin/pip install --no-cache-dir --timeout 180 --retries 15 '/opt/qwen-mm-plugins-src[core,search]' && \
    python3 -m venv /opt/paddleocr-mcp && \
    /opt/paddleocr-mcp/bin/pip install --no-cache-dir --timeout 180 --retries 15 'paddleocr-mcp==0.8.5' && \
    mkdir -p /tmp/qwen-mm-search && chmod 1777 /tmp/qwen-mm-search

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY src/packages/contracts/package.json ./src/packages/contracts/package.json
COPY src/packages/content-integrity/package.json ./src/packages/content-integrity/package.json
COPY src/packages/internal-service/package.json ./src/packages/internal-service/package.json
COPY src/services/pi-chat-runtime/package.json ./src/services/pi-chat-runtime/package.json
# corepack 与 pnpm 走国内 npm 镜像，规避容器内 registry.npmjs.org 的 TLS 断连。
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ftp_proxy all_proxy ALL_PROXY; \
    export no_proxy="*" NO_PROXY="*"; \
    npm config set registry https://registry.npmmirror.com && \
    corepack enable && \
    corepack pnpm config set registry https://registry.npmmirror.com
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ftp_proxy all_proxy ALL_PROXY; \
    export no_proxy="*" NO_PROXY="*"; \
    corepack pnpm install --frozen-lockfile --ignore-scripts --filter @mathpilot/pi-chat-runtime... && \
    corepack pnpm --filter @mathpilot/pi-chat-runtime rebuild esbuild

# Copy only the new Pi runtime. Legacy services, local agent state and .env
# files never enter this image, so the model cannot discover an old runtime.
COPY src/packages/contracts ./src/packages/contracts
COPY src/packages/content-integrity ./src/packages/content-integrity
COPY src/packages/internal-service ./src/packages/internal-service
COPY src/services/pi-chat-runtime ./src/services/pi-chat-runtime

EXPOSE 3105
CMD ["corepack", "pnpm", "--filter", "@mathpilot/pi-chat-runtime", "start"]
