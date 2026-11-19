import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '@/env';
import { encryptionIsActive, withEncryptionExtension } from '@/lib/db/encryption-middleware';
import { registerWorkspaceKeys } from '@/lib/db/key-registry';
import { withRlsTripwire } from '@/lib/db/rls-tripwire';
import type { EncryptedFieldManifest } from '@/lib/security/encrypted-fields';
import { createWorkspaceKeyManager, type WorkspaceKeyManager } from '@/lib/security/workspace-key-manager';

/**
 * The application's Prisma client.
 *
 * Prisma 7 needs a driver adapter: `@prisma/adapter-pg` connects with
 * DATABASE_URL (PgBouncer in the compose stack). Two query extensions are
 * composed onto it (Phase 0.3):
 *
 *   1. field encryption (`src/lib/db/encryption-middleware.ts`), INNER: the
 *      manifest's fields are encrypted on write and decrypted on read, under
 *      the workspace's data key inside `runInWorkspaceContext`;
 *   2. the RLS tripwire (`src/lib/db/rls-tripwire.ts`), OUTER: logs a query on
 *      a workspace-scoped model made outside any database context.
 *
 * The key manager reads `Workspace.encryptedDek` through the UNEXTENDED base
 * client, so a key lookup never re-enters the encryption extension, and
 * `runInWorkspaceContext` makes that lookup BEFORE its transaction opens
 * (the client is registered in `src/lib/db/key-registry.ts`), so it never
 * needs a second pooled connection while the transaction holds one.
 *
 * Workspace-scoped tables are reached ONLY through `runInWorkspaceContext`
 * (`@/lib/db/rls-middleware`), which runs the transaction as `app_user` with
 * `app.workspace_id` set; the bare client is the bypass, used by name through
 * `runWithoutRls`. Repositories and `src/lib/**` infrastructure import this
 * module; a route handler never does (see CLAUDE.md, layer structure).
 *
 * The client is a module-scope singleton, cached on `globalThis` in
 * development so a hot reload does not open a new pool each time.
 */
export interface Database {
    client: PrismaClient;
    keys: WorkspaceKeyManager;
}

export interface CreateDatabaseOptions {
    /** Replaces the encrypted-fields manifest (tests prove the extension against their own). */
    manifest?: EncryptedFieldManifest;
    /** The connection pool's size (pg's default otherwise). Tests shrink it to prove no query needs a second connection. */
    poolMax?: number;
}

export function createDatabase(connectionString: string = env.DATABASE_URL, options: CreateDatabaseOptions = {}): Database {
    const base = new PrismaClient({
        adapter: new PrismaPg({ connectionString, ...(options.poolMax !== undefined ? { max: options.poolMax } : {}) }),
    });
    const keys = createWorkspaceKeyManager(base);
    const client = withRlsTripwire(withEncryptionExtension(base, { keys, manifest: options.manifest }));
    // Only a client that encrypts needs its keys resolved ahead of a
    // workspace transaction (`src/lib/db/key-registry.ts`).
    if (encryptionIsActive(options.manifest)) registerWorkspaceKeys(client, keys);
    return { client, keys };
}

/** A client with the extensions, for code that needs only the client. */
export function createPrismaClient(connectionString: string = env.DATABASE_URL, options: CreateDatabaseOptions = {}): PrismaClient {
    return createDatabase(connectionString, options).client;
}

const globalForPrisma = globalThis as unknown as { inkquisitorDatabase?: Database };

const database: Database = globalForPrisma.inkquisitorDatabase ?? createDatabase();

if (env.NODE_ENV !== 'production') {
    globalForPrisma.inkquisitorDatabase = database;
}

export const prisma: PrismaClient = database.client;

/** The singleton client's workspace key manager (sign-up primes it). */
export const workspaceKeys: WorkspaceKeyManager = database.keys;
