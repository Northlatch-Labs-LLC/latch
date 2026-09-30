# Latch web application (workspace UI + server + Latch account proxy).
# Build context: repo root. Runtime serves the built SPA from ZCODE_WEB_STATIC_ROOT.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @zcode/server build \
 && pnpm --filter @zcode/web build

FROM node:24-bookworm-slim
WORKDIR /repo
COPY --from=build /repo ./
ENV NODE_ENV=production \
    PORT=8785 \
    ZCODE_WEB_STATIC_ROOT=/repo/packages/web/dist \
    ZCODE_DATA_BASE_DIR=/data/latch \
    HOME=/data/latch
VOLUME /data/latch
EXPOSE 8785
CMD ["node", "packages/server/dist/entry-http.js"]
