/**
 * Prisma 7 config — replaces inline `url`/`directUrl` on the
 * `datasource db {}` block, which Prisma 7 rejects.
 *
 * The CLI (prisma migrate / generate / studio) resolves connection
 * URLs from this file. The runtime client (src/lib/db.ts) uses the
 * adapter pattern (`@prisma/adapter-pg`) and reads DATABASE_URL
 * through src/env.ts.
 *
 * Two URLs:
 *   • DATABASE_URL — PgBouncer pooler (transaction mode) used by the
 *     running app.
 *   • DIRECT_DATABASE_URL — direct Postgres connection used by
 *     `prisma migrate`, which needs DDL and lock semantics PgBouncer
 *     does not provide. Falls back to DATABASE_URL.
 *
 * This file is read by the Prisma CLI, not by Next, so it reads
 * process.env directly rather than through src/env.ts. An empty URL is
 * accepted so `prisma generate` (the postinstall step) runs with no
 * database configured.
 */
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
    schema: path.join('prisma', 'schema'),
    migrations: {
        path: path.join('prisma', 'migrations'),
    },
    datasource: {
        url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    },
});
