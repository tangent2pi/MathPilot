# syntax=docker/dockerfile:1.7
# Compose supplies the existing Pi runtime image, including its sandbox and
# Core/Search/OCR plugin environments. Reuse those expensive dependency layers.
FROM pi-runtime
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY src/packages/self-test/package.json ./src/packages/self-test/package.json
COPY src/services/learning-next/package.json ./src/services/learning-next/package.json
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack pnpm install --frozen-lockfile --ignore-scripts --filter @mathpilot/learning-next... && \
    corepack pnpm --filter @mathpilot/learning-next rebuild esbuild @swc/core
RUN apt-get update -q && apt-get install -y --no-install-recommends python3-sympy python3-matplotlib && rm -rf /var/lib/apt/lists/*
COPY src/packages/self-test ./src/packages/self-test
COPY src/services/learning-next ./src/services/learning-next
CMD ["corepack", "pnpm", "--filter", "@mathpilot/learning-next", "start"]
