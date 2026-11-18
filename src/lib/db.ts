import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/env';

/**
 * The application's Prisma client.
 *
 * Prisma 7 needs a driver adapter: `@prisma/adapter-pg` connects with
 * DATABASE_URL (PgBouncer in the compose stack). The client is a
 * module-scope singleton, cached on `globalThis` in development so a hot
 * reload does not open a new pool each time.
 *
 * Phase 0.3 wraps this client with the row-level-security context
 * (`runInWorkspaceContext`) and Phase 0.3 / 1.1 with field encryption; until
 * then nothing in the app reads a table. Repositories are the only layer
 * that may import it (see CLAUDE.md, layer structure).
 */
export function createPrismaClient(connectionString: string = env.DATABASE_URL): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { inkquisitorPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.inkquisitorPrisma ?? createPrismaClient();

if (env.NODE_ENV !== 'production') {
    globalForPrisma.inkquisitorPrisma = prisma;
}
