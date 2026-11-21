# Three-stage image (deps → builder → runner), the pattern of
# inflect-compliance's Dockerfile at the carve commit, cut down to what this
# repository has: the app and the BullMQ worker bundle (Phase 0.4); no seed
# scripts and no workspace package yet.
#
# One image, two processes: the default entrypoint starts the web server;
# the worker runs from the same image with `node dist/worker.mjs`, and its
# healthcheck is `node dist/worker-healthcheck.mjs`.

# ─── Stage 1: Dependencies ─────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# `npm ci` — strict, deterministic install: installs exactly the
# package-lock.json tree and fails if it is out of sync with package.json.
# Never `npm install` in an image build.
#
# The `postinstall` hook is `prisma generate`, so the schema folder and
# prisma.config.ts must be in place BEFORE `npm ci`, or the install fails.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Husky's `prepare` installs git hooks; an image build has no .git and
# commits nothing.
ENV HUSKY=0
RUN npm ci

# ─── Stage 2: Builder ──────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate

# Build Next.js. Env validation is skipped: the real values are provided at
# run time, and no secret is ever baked into the image.
# --webpack: see next.config.mjs for why the build does not use Turbopack.
# `.next/trace` is build-time telemetry nothing reads at run time; deleting it
# here keeps the bytes out of the COPY layer below.
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build --webpack && rm -rf .next/trace

# The worker: scripts/worker.ts bundled by esbuild into dist/ (first-party
# code inlined, node_modules external — so it needs only production deps).
RUN node scripts/build-worker.mjs

# Prune dev dependencies before the runner stage copies node_modules, so the
# runtime image carries no test or lint tooling (and none of its CVEs).
RUN npm prune --omit=dev

# ─── Stage 3: Runner ──────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# OpenSSL for the Prisma schema engine. The version floor busts this layer
# when it is raised, so a cached layer cannot keep shipping an old library.
RUN apk add --no-cache "openssl>=3.5.8-r0"

# Remove the npm CLI from the runtime image: nothing at run time needs it
# (the entrypoint calls the local prisma and next binaries), and a package
# that is absent needs no CVE triage.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm \
    && ! command -v npm \
    && ! command -v npx

# Non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma ./prisma
# Prisma 7 reads connection URLs from prisma.config.ts, not the schema.
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/scripts/entrypoint.sh ./scripts/entrypoint.sh
COPY --from=builder /app/dist ./dist
# The question packs (Phase 2.2), read from disk at process.cwd() by
# src/lib/interview/packs.ts: readable Markdown, so what the interviewer was
# told stays a file a reviewer can open.
COPY --from=builder /app/src/lib/interview/packs ./src/lib/interview/packs
# The PDF export's font (Noto Sans and its OFL licence, issue #24), read at run
# time from <cwd>/fonts/noto-sans (src/lib/pdf/fonts.ts); the working
# directory is /app.
COPY --from=builder /app/fonts ./fonts
# The parse workers (Phase 4.0): plain ESM Node runs as worker threads to read
# an uploaded PDF's text layer and a DOCX through mammoth under a heap limit,
# a memory watch and a deadline (src/lib/sources/parse-worker.ts reads them
# from <cwd>/scripts; tests/unit/sources/parse-worker.test.ts holds this list
# to the scripts it names).
COPY --from=builder /app/scripts/pdf-text-worker.mjs ./scripts/pdf-text-worker.mjs
COPY --from=builder /app/scripts/docx-text-worker.mjs ./scripts/docx-text-worker.mjs

RUN chmod +x ./scripts/entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./scripts/entrypoint.sh"]
