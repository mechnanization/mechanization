# syntax=docker/dockerfile:1
#
# Multi-stage build for the NestJS API inside a pnpm workspace.
#
# The workspace is the awkward part: the backend depends on
# @mechanization/shared-schemas by `workspace:*`, so the build stage needs the
# whole monorepo, while the runner needs only the compiled output and production
# dependencies.

# ── deps ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /repo

# Manifests only, so a source-only change does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared-schemas/package.json packages/shared-schemas/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /repo/packages/shared-schemas/node_modules ./packages/shared-schemas/node_modules
COPY . .

# Prisma clients are generated, not committed — both of them, since
# schema-per-tenant uses a separate client for the registry and the tenants.
RUN pnpm --filter @mechanization/shared-schemas build \
 && pnpm --filter @mechanization/backend prisma:generate \
 && pnpm --filter @mechanization/backend build

# Strip dev dependencies rather than reinstalling: faster, and guaranteed to
# match what was just built against.
RUN pnpm --filter @mechanization/backend --prod deploy /app-out

# ── runner ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
# The process clock is part of the contract, not an ambient property of the
# host: billing period keys are built with getUTC*, and a container inheriting
# a local zone would put the 1st-of-the-month run in the previous period. The
# @Cron decorators pin UTC too — this pins everything else that reads the clock.
# No tzdata package needed: UTC is the one zone musl resolves without it.
ENV TZ=UTC

# Never run as root: this process holds the service-role storage key and a
# connection to every municipality's data.
RUN addgroup -S nodejs -g 1001 && adduser -S nestjs -u 1001
USER nestjs

COPY --from=build --chown=nestjs:nodejs /app-out/node_modules ./node_modules
COPY --from=build --chown=nestjs:nodejs /repo/apps/backend/dist ./dist
# The generated clients live outside dist/ and are required at runtime.
COPY --from=build --chown=nestjs:nodejs /repo/apps/backend/src/generated ./src/generated

EXPOSE 4000

# `dist/presentation/main` — the entry point moved when v2 adopted the
# layer-first structure.
CMD ["node", "dist/presentation/main"]
