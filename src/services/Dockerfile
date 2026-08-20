# syntax=docker/dockerfile:1.7
# 共享服务镜像：Node 24 直接运行 TS（type stripping），pnpm workspace 安装。
# 用法（compose）：build: { context: ../.., dockerfile: src/services/Dockerfile, args: { SERVICE_NAME: learning } }
# P0-2 容器化：profile 服务在镜像内安装 pyBKT 侧车 venv（PYBKT_PYTHON 默认 resolve("sidecars/pybkt/.venv/bin/python")，
# 在 WORKDIR=/app 下解析到 /app/sidecars/pybkt/.venv/bin/python，无需宿主机路径）。
# Debian/glibc 可直接使用 numpy、pandas、scikit-learn 的 manylinux wheel；避免 Alpine/musl
# 在 Python 次版本升级后退回耗时且脆弱的本地 C/C++ 编译。
FROM node:24-bookworm-slim
ARG SERVICE_NAME
ENV SERVICE_NAME=${SERVICE_NAME}
ENV NODE_ENV=production
# Qwen-MM-Plugins 来自仓库旁固定的本地克隆；不在构建时下载另一份版本。
# 这份 COPY 只在上游克隆改变时使后续依赖层失效。
COPY references/qwen-mm-plugins /opt/qwen-mm-plugins-src

# 把大体积、低频变化的系统/Qwen/Hyperframes 依赖放在业务源码 COPY 之前，避免每次业务改动
# 都重新安装 Chromium、LibreOffice 与 Python wheels。
RUN if [ "$SERVICE_NAME" = "profile" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$SERVICE_NAME" = "agent-runtime" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends ripgrep findutils gawk jq util-linux bubblewrap ca-certificates curl tar python3 python3-venv python3-psycopg2 python3-numpy python3-scipy python3-sympy postgresql-client socat ffmpeg chromium libreoffice-writer libreoffice-impress fonts-noto-cjk && \
      npm install --global hyperframes@0.8.3 && \
      python3 -m venv /opt/qwen-mm && \
      /opt/qwen-mm/bin/pip install --no-cache-dir \
        '/opt/qwen-mm-plugins-src[core,search]' && \
      python3 -m venv /opt/paddleocr-mcp && \
      /opt/paddleocr-mcp/bin/pip install --no-cache-dir 'paddleocr-mcp==0.8.5' && \
      mkdir -p /tmp/qwen-mm-search && chmod 1777 /tmp/qwen-mm-search && \
      rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=agmath-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts && \
    corepack pnpm rebuild esbuild

# pyBKT 侧车 venv（sidecars/pybkt/setup.sh：numpy<2 + scikit-learn<1.6 钉版 + EM_fit 补丁）
# .venv 由 .dockerignore 排除（宿主 venv 与容器不兼容）；容器内新建并钉版安装。
# Agent runtime 在 COPY 后把上游与产品 Skill 装配成唯一的 /opt/agmath-skills 树。
RUN if [ "$SERVICE_NAME" = "profile" ]; then \
      rm -rf sidecars/pybkt/.venv && \
      bash sidecars/pybkt/setup.sh; \
    elif [ "$SERVICE_NAME" = "agent-runtime" ]; then \
      sh src/services/agent-runtime/scripts/stage-skills.sh /opt/agmath-skills /opt/qwen-mm-plugins-src && \
      install -m 0755 src/services/agent-runtime/qwen-mm-search-mcp.sh /usr/local/bin/qwen-mm-search-mcp && \
      install -m 0755 src/services/agent-runtime/qwen-mm-core-mcp.sh /usr/local/bin/qwen-mm-core-mcp && \
      install -m 0755 src/services/agent-runtime/paddleocr-mcp.sh /usr/local/bin/agmath-paddleocr-mcp && \
      install -m 0755 src/services/agent-runtime/agent-runtime-entrypoint.sh /usr/local/bin/agmath-agent-runtime-entrypoint; \
    fi
CMD if [ "$SERVICE_NAME" = "agent-runtime" ]; then exec /usr/local/bin/agmath-agent-runtime-entrypoint; else exec corepack pnpm --filter @mathpilot/${SERVICE_NAME} run start; fi
