FROM node:22.23.2-bookworm-slim AS build
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/auth/package.json apps/auth/
COPY apps/connector-gateway/package.json apps/connector-gateway/
COPY apps/db-bridge/package.json apps/db-bridge/
COPY apps/legacy-exporter/package.json apps/legacy-exporter/
COPY apps/mcp/package.json apps/mcp/
COPY apps/savia-request/package.json apps/savia-request/
COPY apps/self-hosted/package.json apps/self-hosted/
COPY apps/vscode/package.json apps/vscode/
COPY packages/plugin-authoring/package.json packages/plugin-authoring/
COPY packages/studio-server/package.json packages/studio-server/
COPY packages/studio-shared/package.json packages/studio-shared/
COPY packages/db/package.json packages/db/
COPY packages/release-catalog/package.json packages/release-catalog/
COPY packages/tenant-host/package.json packages/tenant-host/
RUN --mount=type=cache,id=savia-pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @savia/admin run build:assets
RUN node scripts/prepare-office-runtime.mjs
RUN mkdir -p apps/admin/dist/office/runtime && cp -R .cache/office-runtime/. apps/admin/dist/office/runtime/
RUN --mount=type=cache,id=savia-pnpm,target=/root/.local/share/pnpm/store CI=true pnpm install --prod --offline --frozen-lockfile

FROM node:22.23.2-bookworm-slim
WORKDIR /srv
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
ENV SAVIA_DATA_DIR=/data SAVIA_ADMIN_DIR=/srv/apps/admin/dist
COPY --from=build /srv/package.json /srv/pnpm-workspace.yaml ./
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/apps ./apps
COPY --from=build /srv/packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--import", "./apps/self-hosted/node_modules/tsx/dist/loader.mjs", "apps/self-hosted/src/index.ts"]
