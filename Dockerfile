# syntax=docker/dockerfile:1.7
#
# Multi-stage build producing three runnable images from one context, selected
# with --target: gateway, worker or dashboard.
#
#   docker build --target gateway  -t ai-gateway/gateway .
#   docker build --target worker   -t ai-gateway/worker .
#   docker build --target dashboard -t ai-gateway/dashboard .

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Copy only the manifests first so a source change does not invalidate the
# dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json               packages/core/
COPY packages/pricing/package.json            packages/pricing/
COPY packages/provider-sdk/package.json       packages/provider-sdk/
COPY packages/providers/package.json          packages/providers/
COPY packages/router/package.json             packages/router/
COPY packages/policies/package.json           packages/policies/
COPY packages/cache/package.json              packages/cache/
COPY packages/rate-limit/package.json         packages/rate-limit/
COPY packages/observability/package.json      packages/observability/
COPY packages/usage/package.json              packages/usage/
COPY packages/security/package.json           packages/security/
COPY packages/sdk/package.json                packages/sdk/
COPY packages/database/package.json           packages/database/
COPY packages/config/package.json             packages/config/
COPY packages/ui/package.json                 packages/ui/
COPY apps/gateway/package.json                apps/gateway/
COPY apps/worker/package.json                 apps/worker/
COPY apps/cli/package.json                    apps/cli/
COPY apps/mcp/package.json                    apps/mcp/
COPY apps/dashboard/package.json              apps/dashboard/
COPY tests/package.json                       tests/
COPY benchmarks/package.json                  benchmarks/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm build

# ── gateway ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS gateway
RUN corepack enable && apk add --no-cache curl tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/gateway ./apps/gateway

# Run unprivileged. The gateway holds provider credentials; it has no business
# running as root.
USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually drains
# in-flight streaming responses instead of being killed mid-stream.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/gateway/dist/server.js"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS worker
RUN corepack enable && apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/gateway ./apps/gateway
COPY --from=build /app/apps/worker ./apps/worker

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/worker/dist/main.js"]

# ── dashboard ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-build
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
RUN pnpm --filter @ai-gateway/dashboard build

FROM node:22-alpine AS dashboard
RUN apk add --no-cache curl tini
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

# Next's standalone output already contains the pruned node_modules it needs.
COPY --from=dashboard-build /app/apps/dashboard/.next/standalone ./
COPY --from=dashboard-build /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=dashboard-build /app/apps/dashboard/public ./apps/dashboard/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/connect || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/dashboard/server.js"]
