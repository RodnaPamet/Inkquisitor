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
 *
 * Prisma 7's CLI no longer loads `.env`, and Next does so only for itself.
 * So `.env` is loaded here (Node's built-in `util.parseEnv`, no new
 * dependency); without it `npm run db:migrate` after the README's
 * `cp .env.example .env` reports "Connection url is empty". A variable
 * already exported wins over the file, and a missing file is not an error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'prisma/config';

/**
 * Load `file` into process.env without overriding exported variables, as
 * `process.loadEnvFile` would. Parsed with `util.parseEnv` and assigned here
 * rather than through `loadEnvFile` so the assignment lands on the
 * `process.env` this module sees (Jest gives each test file its own copy).
 */
export function loadDotEnv(file = '.env'): void {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
    }
    for (const [key, value] of Object.entries(parseEnv(text))) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

/**
 * The URL `prisma migrate` connects with. `||`, not `??`: an empty
 * DIRECT_DATABASE_URL (the compose `${VAR:-}` shape) falls back to
 * DATABASE_URL rather than winning as ''.
 */
export function datasourceUrl(env: Record<string, string | undefined> = process.env): string {
    return env.DIRECT_DATABASE_URL || env.DATABASE_URL || '';
}

loadDotEnv();

export default defineConfig({
    schema: path.join('prisma', 'schema'),
    migrations: {
        path: path.join('prisma', 'migrations'),
    },
    datasource: {
        url: datasourceUrl(),
    },
});
