# syntax=docker/dockerfile:1
# Jeden kontajner: web + /api + /mcp + denný ingest. Index žije vo volume /data.

FROM node:24-bookworm-slim AS build
WORKDIR /app
# pnpm verzia sa berie z "packageManager" v package.json; CI=true → pnpm sa nepýta pri prepise node_modules
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
# po builde preinštalovať len produkčné závislosti (z lokálneho store, bez siete).
# packages/mcp/dist (nezbundlovaný, používa ho server) importuje @skfirma/core,
# ktorý je v mcp len devDependency (biny ho majú zbundlovaný) — rieši ho
# závislosť koreňového package.json → /app/node_modules/@skfirma/core.
RUN pnpm build && pnpm install --prod --frozen-lockfile --offline

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    SKFIRMA_INDEX_PATH=/data/skfirma-index.sqlite \
    SKFIRMA_INGEST_INTERVAL_HOURS=24 \
    WEB_DIR=/app/apps/web/dist \
    TRUST_PROXY=none
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/mcp/package.json packages/mcp/
COPY --from=build /app/packages/mcp/node_modules packages/mcp/node_modules
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
