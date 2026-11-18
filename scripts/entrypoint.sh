#!/bin/sh
set -e

echo "→ Inkquisitor — container start"

# ── 1. Apply Prisma migrations (idempotent) ──
# Runs the CLI already in the image (`prisma` is a production dependency),
# never `npx`, which would fetch a second copy from the registry. The CLI reads
# DIRECT_DATABASE_URL (or DATABASE_URL) through prisma.config.ts.
echo "→ Applying database migrations..."
./node_modules/.bin/prisma migrate deploy
echo "✓ Migrations applied"

# ── 2. Start the server ──
# `exec` hands PID 1 to Next so it receives SIGTERM directly.
echo "→ Starting Next.js..."
exec ./node_modules/.bin/next start
