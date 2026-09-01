# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches ./patches
COPY src/packages/content-integrity/package.json ./src/packages/content-integrity/package.json
COPY src/packages/contracts/package.json ./src/packages/contracts/package.json
COPY src/packages/internal-service/package.json ./src/packages/internal-service/package.json
COPY src/services/learning-next/package.json ./src/services/learning-next/package.json
RUN --mount=type=cache,id=mathpilot-next-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    corepack enable && \
    corepack pnpm install --frozen-lockfile --ignore-scripts --filter @mathpilot/learning-next... && \
    corepack pnpm --filter @mathpilot/learning-next rebuild esbuild @swc/core

# Only the Next runtime, content integrity owner, canonical contracts, shared service identity, and versioned task Skills enter this image.
COPY src/packages/content-integrity ./src/packages/content-integrity
COPY src/packages/contracts ./src/packages/contracts
COPY src/packages/internal-service ./src/packages/internal-service
COPY src/services/learning-next ./src/services/learning-next

CMD ["corepack", "pnpm", "--filter", "@mathpilot/learning-next", "start"]
