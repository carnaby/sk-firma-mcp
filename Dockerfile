# syntax=docker/dockerfile:1
# Jeden kontajner: web + /api + /mcp + denný ingest. Index žije vo volume /data.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# toolchain pre better-sqlite3, ak sa nepodarí stiahnuť prebuilt binárka
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SKFIRMA_INDEX_PATH=/data/skfirma-index.sqlite \
    SKFIRMA_INGEST_INTERVAL_HOURS=24 \
    WEB_DIR=/app/apps/web/dist \
    TRUST_PROXY=1
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/mcp/package.json packages/mcp/
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
