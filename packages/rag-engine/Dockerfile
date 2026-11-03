# Bucket Intelligence engine for Forge appliances.
#
# Build from the repository root (the engine imports workspace packages):
#
#   docker build -f packages/rag-engine/Dockerfile -t filone/rag-engine .
#
# Multi-arch (the native LanceDB module is published for both):
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f packages/rag-engine/Dockerfile -t <registry>/rag-engine:<tag> --push .
#
# The image runs TypeScript directly with Node's type stripping, the way the
# repository runs its scripts, so the workspace layout is kept as is.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/rag-shared/package.json packages/rag-shared/
COPY packages/rag-engine/package.json packages/rag-engine/
# Production dependencies of the engine and the workspace packages it uses.
# pnpm installs only the LanceDB native build for the target platform.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @filone/rag-engine...

FROM node:24-bookworm-slim
# LanceDB's HTTP client loads the system root certificates at startup and
# fails without them, even for plain-HTTP endpoints.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Lance logs deprecation and index-statistics warnings to stderr on every
# hybrid query and status call; keep the appliance logs to errors. The Node
# binding reads LANCEDB_LOG (LANCE_LOG has no effect on it).
ENV LANCEDB_LOG=error
WORKDIR /app
COPY --from=deps /app ./
COPY packages/shared/src packages/shared/src
COPY packages/rag-shared/src packages/rag-shared/src
COPY packages/rag-engine/src packages/rag-engine/src
WORKDIR /app/packages/rag-engine
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ENGINE_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
