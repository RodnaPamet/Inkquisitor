/**
 * THE BACKUP AND RESTORE DRILL (Phase 5.H-a, D36; roadmap 5.H item 6), run on every CI build: the runbook in
 * docs/backup-restore.md, end to end, against the integration database.
 *
 *   1. a workspace is made with what a restore must bring back intact: encrypted author text (a bible field, a
 *      scene's text and its versions), a hash-chained audit trail, row-level security, vectors;
 *   2. the database is dumped with `pg_dump --format=custom` and restored with `pg_restore` into a FRESH database;
 *   3. the restored copy is read back THROUGH THE PRODUCT'S OWN CLIENT (`createDatabase`, the encryption extension
 *      and row-level security, under the same DATA_ENCRYPTION_KEY): every workspace-scoped table holds the same rows
 *      for the workspace, every encrypted column the same ciphertext, which decrypts to the same text with the
 *      workspace's data key; the audit chain verifies; every policy is there, and isolates; the append-only triggers
 *      still refuse; the vectors are the same, and a nearest-neighbour search answers the same.
 *
 * THE TOOLS. pg_dump and pg_restore must be the server's major version. With `PG_TOOLS_CONTAINER` set (CI: the
 * `ci-postgres` container the Test job starts) they run inside that container (`docker exec`), so they are exactly
 * the image's; otherwise they are taken from PATH and their version is checked. Missing tools FAIL this test, with
 * the reason: an integration test never skips.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createDatabase, prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { verifyAuditChain } from '@/lib/audit/audit-writer';
import { BibleFieldRepository } from '@/app-layer/repositories/bible.repository';
import { ManuscriptSceneRepository } from '@/app-layer/repositories/manuscript.repository';
import { createBook } from '@/app-layer/usecases/books';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createChapter, createScene } from '@/app-layer/usecases/manuscript';
import { checkpointScene, saveSceneText } from '@/app-layer/usecases/manuscript-scenes';
import { executeFactLayerDispatch } from '@/app-layer/usecases/fact-layer-dispatch';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings/stub-provider';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

jest.setTimeout(10 * 60 * 1000);

const CONTAINER = process.env.PG_TOOLS_CONTAINER || null;
const BASE_URL = process.env.DATABASE_URL!;
/** libpq refuses Prisma's `schema` parameter. */
function libpqUrl(url: string, database?: string): string {
    const u = new URL(url);
    u.searchParams.delete('schema');
    if (database) u.pathname = `/${database}`;
    return u.toString();
}
const DRILL_DB = `${new URL(BASE_URL).pathname.slice(1)}_drill_${process.pid}`;

function tool(name: 'pg_dump' | 'pg_restore', args: string[], input?: Buffer): Buffer {
    const r = CONTAINER
        ? spawnSync('docker', ['exec', '-i', CONTAINER, name, ...args], { input, maxBuffer: 4 * 1024 * 1024 * 1024 })
        : spawnSync(name, args, { input, maxBuffer: 4 * 1024 * 1024 * 1024 });
    if (r.error) throw new Error(`${name} could not run (${CONTAINER ? `in container ${CONTAINER}` : 'from PATH'}): ${r.error.message}. Install the PostgreSQL client tools of the server's major version, or set PG_TOOLS_CONTAINER.`);
    if (r.status !== 0) throw new Error(`${name} failed (${r.status}): ${r.stderr.toString('utf8').slice(0, 2000)}`);
    return r.stdout;
}

const SCOPED = parseSchemaModels().filter((m) => m.scalarFieldNames.includes('workspaceId'));
const SECRET_FIELD = 'Wren never learned to swim; the drill must bring this back.';
const SCENE_TEXT = '<p>The lock gates held through the night. <em>Nobody</em> slept.</p>';

let restored: PrismaClient | null = null;
let created = false;

afterAll(async () => {
    await restored?.$disconnect();
    if (created) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
    await prisma.$disconnect();
});

it('a dump restored into a fresh database brings one workspace back intact: encrypted text, audit chain, RLS, vectors', async () => {
    // ── 1. A workspace worth restoring ──
    const ctx = workspaceCtx(await createAccount({ workspaceName: 'Backup drill' }));
    const bookId = (await createBook(ctx, { title: 'Harrow Weir' })).id;
    const wren = await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Wren', summary: 'The lock keeper’s daughter.', fields: [{ key: 'want', value: SECRET_FIELD }] });
    const chapter = await createChapter(ctx, bookId, { title: 'Flood' });
    const sceneId = (await createScene(ctx, bookId, { chapterId: chapter.id, title: 'The night of the flood' })).id;
    const saved = await saveSceneText(ctx, bookId, sceneId, { html: SCENE_TEXT, baseRevision: 0 }, { enqueueProseCheck: async () => undefined });
    await checkpointScene(ctx, bookId, sceneId, { revision: saved.revision });
    await executeFactLayerDispatch({ enqueue: async () => undefined, extractionOpen: () => false, embedder: () => new StubEmbeddingProvider(), workspaceIds: [ctx.workspaceId] });

    const original = await snapshot(prisma, ctx.workspaceId);
    expect(original.vectors.length).toBeGreaterThan(0);
    expect(original.audit.valid).toBe(true);
    expect(original.audit.totalEntries).toBeGreaterThan(3);
    expect(original.ciphertexts.field.startsWith('v2:')).toBe(true);

    // ── 2. Dump, and restore into a fresh database ──
    const server = Number((await prisma.$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version_num') AS v`)[0].v.slice(0, -4));
    const version = tool('pg_dump', ['--version']).toString('utf8');
    expect({ toolMajor: Number(/(\d+)\.\d+/.exec(version)?.[1]), serverMajor: server }).toEqual({ toolMajor: server, serverMajor: server });
    const dump = tool('pg_dump', ['--format=custom', '--no-password', `--dbname=${libpqUrl(BASE_URL)}`]);
    expect(dump.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${DRILL_DB}"`);
    created = true;
    tool('pg_restore', ['--exit-on-error', '--no-password', `--dbname=${libpqUrl(BASE_URL, DRILL_DB)}`], dump);

    // ── 3. Read the copy back through the product's own client ──
    const db = createDatabase(libpqUrl(BASE_URL, DRILL_DB) + '?schema=public');
    restored = db.client;
    const copy = await snapshot(restored, ctx.workspaceId);
    expect(copy.rows).toEqual(original.rows);
    expect(copy.ciphertexts).toEqual(original.ciphertexts);
    expect(copy.audit).toEqual(original.audit);
    expect(copy.policies).toEqual(original.policies);
    expect(copy.vectors).toEqual(original.vectors);

    // Encrypted text decrypts with the workspace's data key (unwrapped from the restored row under the same master key).
    const read = await runInWorkspaceContext(
        ctx,
        async (tx) => ({
            fields: await BibleFieldRepository.listForElements(tx, ctx.workspaceId, [wren.id], 50),
            scene: await ManuscriptSceneRepository.find(tx, ctx.workspaceId, bookId, sceneId),
        }),
        { client: restored },
    );
    expect(read.fields.find((f) => f.key === 'want')?.value).toBe(JSON.stringify(SECRET_FIELD));
    expect(read.scene?.text).toBe(SCENE_TEXT);

    // Row-level security isolates in the copy: another workspace's context reads none of it.
    const stranger = await createAccount();
    const seen = await runInWorkspaceContext({ workspaceId: stranger.workspaceId, requestId: randomUUID() }, (tx) => tx.book.count({ where: { id: bookId } }), { client: restored }).catch(() => 'NO_KEY_IN_COPY');
    // The stranger was made after the dump, so the copy holds no key for it: read as app_user with its id bound instead.
    if (seen === 'NO_KEY_IN_COPY') {
        const n = await restored.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE app_user`;
            await tx.$executeRaw`SELECT set_config('app.workspace_id', ${stranger.workspaceId}, true)`;
            return tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Book" WHERE "id" = ${bookId}`;
        });
        expect(n[0].n).toBe(0);
    } else {
        expect(seen).toBe(0);
    }

    // The append-only triggers came back too.
    await expect(restored.$executeRaw`DELETE FROM "AuditLog" WHERE "workspaceId" = ${ctx.workspaceId}`).rejects.toThrow(/append-only/);
    await expect(restored.$executeRaw`DELETE FROM "SceneVersion" WHERE "sceneId" = ${sceneId}`).rejects.toThrow(/SCENE_VERSION_APPEND_ONLY/);

    // A nearest-neighbour search answers the same in the copy.
    const nearest = async (client: PrismaClient) =>
        runWithoutRls({ reason: 'test', client }, (c) =>
            c.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "VectorEmbedding" WHERE "workspaceId" = ${ctx.workspaceId}
                ORDER BY "embedding" <=> (SELECT "embedding" FROM "VectorEmbedding" WHERE "workspaceId" = ${ctx.workspaceId} ORDER BY "id" LIMIT 1), "id" LIMIT 3`,
        );
    expect(await nearest(restored)).toEqual(await nearest(prisma));
});

/** What a restore must reproduce for one workspace. */
async function snapshot(client: PrismaClient, workspaceId: string) {
    return runWithoutRls({ reason: 'test', client }, async (db) => {
        const rows: Record<string, number> = {};
        for (const m of SCOPED) {
            const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${m.tableName}" WHERE "workspaceId" = $1`, workspaceId);
            rows[m.tableName] = n;
        }
        const [field] = await db.$queryRaw<Array<{ value: string }>>`SELECT f."value" FROM "BibleField" f WHERE f."workspaceId" = ${workspaceId} AND f."key" = 'want' LIMIT 1`;
        const [scene] = await db.$queryRaw<Array<{ text: string }>>`SELECT "text" FROM "ManuscriptScene" WHERE "workspaceId" = ${workspaceId} LIMIT 1`;
        const versions = await db.$queryRaw<Array<{ text: string }>>`SELECT "text" FROM "SceneVersion" WHERE "workspaceId" = ${workspaceId} ORDER BY "id"`;
        const [dek] = await db.$queryRaw<Array<{ encryptedDek: string }>>`SELECT "encryptedDek" FROM "Workspace" WHERE "id" = ${workspaceId}`;
        const policies = await db.$queryRaw<Array<{ t: string; p: string; qual: string | null; check: string | null }>>`
            SELECT tablename AS t, policyname AS p, qual, with_check AS "check" FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`;
        const forced = await db.$queryRaw<Array<{ t: string }>>`SELECT relname AS t FROM pg_class WHERE relforcerowsecurity AND relkind = 'r' ORDER BY relname`;
        const vectors = await db.$queryRaw<Array<{ id: string; v: string }>>`SELECT "id", "embedding"::text AS v FROM "VectorEmbedding" WHERE "workspaceId" = ${workspaceId} ORDER BY "id"`;
        const audit = await verifyAuditChain(workspaceId, { client });
        return {
            rows,
            ciphertexts: { field: field.value, scene: scene.text, versions: versions.map((v) => v.text), dek: dek.encryptedDek },
            audit,
            policies: { policies, forced: forced.map((f) => f.t) },
            vectors,
        };
    });
}
