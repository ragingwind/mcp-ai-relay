# syntax=docker/dockerfile:1
#
# Multi-stage build for the Hono-based MCP relay (`app/` workspace package).
# Stage 1 (deps):    install workspace dependencies via pnpm.
# Stage 2 (builder): compile the SDK and the app to dist/.
# Stage 3 (runner):  alpine + node + minimal artifacts; runs as non-root.
#
# Built and pushed by .github/workflows/release-app.yml as
# ghcr.io/ragingwind/ai-relay (multi-arch: amd64+arm64).

ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
RUN corepack enable pnpm
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ai-relay/package.json ./packages/ai-relay/
COPY app/package.json ./app/
RUN pnpm install --frozen-lockfile

FROM ${NODE_IMAGE} AS builder
WORKDIR /repo
RUN corepack enable pnpm
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages/ai-relay/node_modules ./packages/ai-relay/node_modules
COPY --from=deps /repo/app/node_modules ./app/node_modules
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./
COPY packages/ai-relay ./packages/ai-relay
COPY app ./app
RUN pnpm -r build
# Materialize a self-contained tree for the app via `pnpm deploy` —
# this is the documented pnpm-workspace pattern for producing a
# minimal runtime image (resolves workspace:* links + prod deps).
# Root `pnpm.overrides` substitutes `next`/`react`/`react-dom` (mcp-handler's
# unused peer deps) with the 328-byte `empty-npm-package` stub so they do not
# bloat the deploy bundle. `--no-optional` additionally skips any optional
# native binaries. Combined, the deploy tree shrinks from ~500 MB → ~30 MB.
RUN pnpm --filter app deploy --prod --no-optional /deploy

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV AI_RELAY_PORT=8787

RUN addgroup -S app && adduser -S app -u 1001 -G app
USER app

COPY --from=builder --chown=app:app /deploy/dist ./dist
COPY --from=builder --chown=app:app /deploy/node_modules ./node_modules
COPY --from=builder --chown=app:app /deploy/package.json ./package.json

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.AI_RELAY_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
