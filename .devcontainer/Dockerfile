# syntax=docker/dockerfile:1
FROM node:22-bookworm

RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi \
    && apt-get update && apt-get install -y --no-install-recommends curl lsof ca-certificates git procps python3 make g++ zip unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.24.0

WORKDIR /workspace
# Seed writable directories for Docker named volumes before the source bind mount.
RUN mkdir -p \
    /workspace/node_modules \
    /workspace/apps/admin/node_modules \
    /workspace/apps/api/node_modules \
    /workspace/apps/auth/node_modules \
    /workspace/apps/backup-coordinator/node_modules \
    /workspace/apps/companion/node_modules \
    /workspace/apps/connector-gateway/node_modules \
    /workspace/apps/db-bridge/node_modules \
    /workspace/apps/flows/node_modules \
    /workspace/apps/flows/api/node_modules \
    /workspace/apps/flows/app/node_modules \
    /workspace/apps/flows/packages/geo/node_modules \
    /workspace/apps/flows/packages/native/node_modules \
    /workspace/apps/flows/packages/runtime/node_modules \
    /workspace/apps/flows/packages/types/node_modules \
    /workspace/apps/flows/packages/utils/node_modules \
    /workspace/apps/legacy-exporter/node_modules \
    /workspace/apps/mcp/node_modules \
    /workspace/apps/plugin-registry/node_modules \
    /workspace/apps/hook-executor/node_modules \
    /workspace/apps/savia-request/node_modules \
    /workspace/apps/self-hosted/node_modules \
    /workspace/apps/vscode/node_modules \
    /workspace/packages/db/node_modules \
    /workspace/packages/plugin-authoring/node_modules \
    /workspace/packages/plugin-example-tasks/node_modules \
    /workspace/packages/plugin-sdk/node_modules \
    /workspace/packages/plugin-ui/node_modules \
    /workspace/packages/release-catalog/node_modules \
    /workspace/packages/studio-server/node_modules \
    /workspace/packages/studio-shared/node_modules \
    /workspace/packages/tenant-host/node_modules \
    /workspace/apps/api/.wrangler \
    /workspace/apps/auth/.wrangler \
    /workspace/apps/hook-executor/.wrangler \
    /workspace/apps/savia-request/.wrangler \
    /home/node/.local/share/pnpm/store \
    && chown -R node:node /workspace /home/node/.local
USER node
CMD ["sh", ".devcontainer/start.sh"]
