/**
 * The pgvector backend: vectors in Postgres, inside the workspace's RLS.
 *
 * Carved from inflect-compliance's
 * `src/app-layer/repositories/vector/pgvector-store.ts`
 * (docs/carve-manifest.md). What changed, and why:
 *
 *   • It runs on the CALLER's transaction. Inkquisitor's repositories take the
 *     `db` that `runInWorkspaceContext` hands a usecase, so a usecase deletes
 *     a source row and its vectors in one transaction, and an upsert commits
 *     with the change that caused it. A rebuild, which needs many
 *     transactions, takes an `inWorkspace` that opens each one.
 *   • There is no chunk table. Inflect keeps chunk text in an encrypted
 *     `KnowledgeChunk` and refuses a vector whose chunk is missing; here the
 *     text stays in its source row (the vectors-only rule, `./types.ts`), so
 *     the row's key names the source directly.
 *   • Search is EXACT only (`../vector-search-params.ts`): no HNSW index
 *     exists until the production model is chosen, so the iterative-scan
 *     strategies and their fallback are not carried.
 *
 * ── The table ───────────────────────────────────────────────────────
 *
 * Migration `20261119300000_vector_store` creates the extension and
 * `VectorEmbedding` (a key, a book scope, a keyed content hash, the dimension
 * count and the vector, never text). This file is the only one under `src/`
 * that names the table (ESLint `local/vector-store-single-seam`).
 *
 * It fails closed: every call first asks the transaction what it is bound to,
 * and refuses `NOT_IN_WORKSPACE_CONTEXT` unless it runs as `app_user` with
 * `app.workspace_id` equal to the workspace the call names — so the
 * `workspace_isolation` policy and the `"workspaceId" = …` filter every
 * statement ALSO carries (defence in depth) name the same workspace. The same
 * probe refuses `PGVECTOR_NOT_INSTALLED` when the extension (0.8.0 or later)
 * or the table is missing.
 *
 * ── SQL shape ───────────────────────────────────────────────────────
 *
 * Tagged `Prisma.sql` only — every value is a bind parameter. The two things
 * that are not are the table name (a constant) and a vector's dimension
 * count, which is interpolated with `Prisma.raw` because a type modifier
 * cannot be a parameter; it is an integer the repository has already bounded
 * to `1..MAX_DIMENSIONS`, and `dimensionSql` re-checks it before it is spliced.
 * Key order is `COLLATE "C"`, the in-process backend's code-unit order.
 *
 * ── A rebuild never erases a concurrent write ──────────────────────
 *
 * A rebuild runs over many transactions and ends by deleting the revision's
 * rows it did not stamp. Every write stamps `writeSeq` from the table's
 * sequence after taking a SHARED advisory lock on (workspace, revision); the
 * rebuild draws its own `startSeq` under the EXCLUSIVE lock, which waits for
 * every write in flight to commit. So `writeSeq > startSeq` means "written
 * after the rebuild began", and the final DELETE spares those rows.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
import {
    EXACT_SCAN_WARN_ROWS,
    MAX_DIMENSIONS,
    VectorStoreError,
    keyOf,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorDb,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './types';

/** The embedding table. Named here and nowhere else in `src/` (ESLint local/vector-store-single-seam). */
const TABLE = Prisma.raw('"VectorEmbedding"');
/** The sequence behind `"writeSeq"` (a `BIGSERIAL`). */
const WRITE_SEQ = Prisma.raw(`'"VectorEmbedding_writeSeq_seq"'`);

/** Iterative index scans arrived in pgvector 0.8.0; the HNSW search 2.1 adds will need them. */
export const MIN_PGVECTOR_VERSION: readonly [number, number, number] = [0, 8, 0];

function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
    const parts = version.split('.').map((p) => Number.parseInt(p, 10));
    for (let i = 0; i < 3; i++) {
        const v = Number.isFinite(parts[i]) ? parts[i] : 0;
        if (v !== min[i]) return v > min[i];
    }
    return true;
}

/** The (workspace, revision) advisory-lock key pair; its two halves keep it apart from one-key locks. */
function lockKey(workspaceId: string, embeddingRevision: string): Prisma.Sql {
    return Prisma.sql`hashtext(${`vector-store:${workspaceId}`}), hashtext(${embeddingRevision})`;
}

/**
 * The key that serialises a workspace's FIRST writes of any revision
 * (`writeBatch`; issue #23, item 3). One key per workspace, not per revision:
 * two transactions that each make the first write of two revisions, in
 * opposite orders, would otherwise each hold one revision's lock and wait for
 * the other's (40P01). With one key there is no order to get wrong. A first
 * write is rare (once per revision per workspace), so serialising them costs
 * nothing a later write pays.
 */
function firstWriteLockKey(workspaceId: string): Prisma.Sql {
    return Prisma.sql`hashtext(${`vector-store-first-write:${workspaceId}`}), hashtext('first-write')`;
}

/**
 * The isolation level every write needs (issue #23, item 3). The first-write
 * lock works because the statement after it takes a FRESH snapshot and sees
 * the first writer's committed rows: true under READ COMMITTED (what
 * `runInWorkspaceContext` uses), false under REPEATABLE READ or SERIALIZABLE,
 * whose snapshot predates the lock. A write in such a transaction is refused,
 * by name, rather than allowed to fix a revision's dimension count twice.
 */
export const VECTOR_WRITE_ISOLATION = 'read committed';

function dimensionSql(dimensions: number): Prisma.Sql {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
        throw new VectorStoreError('INVALID_QUERY', 'dimension count out of range');
    }
    return Prisma.raw(String(dimensions));
}

/** pgvector's text input form, `[1,2,3]`. The numbers are validated finite upstream. */
function vectorLiteral(embedding: readonly number[]): string {
    return `[${embedding.join(',')}]`;
}

/**
 * The nearest-neighbour query, exported so the integration suite can read its
 * plan. EXACT: it orders by the distance of the UNCAST column, an expression
 * no index matches, so whatever index a later migration adds, this path stays
 * a scan of the workspace's (and, with a scope, the book's) rows of one
 * revision, reached through a workspace-leading btree.
 */
export function buildSearchQuery(workspaceId: string, query: VectorSearchQuery, dimensions: number): Prisma.Sql {
    const d = dimensionSql(dimensions);
    const q = vectorLiteral(query.embedding);
    const distance = Prisma.sql`("embedding" <=> (${q}::vector(${d})))`;
    const book = query.bookId !== undefined ? Prisma.sql`AND "bookId" = ${query.bookId}` : Prisma.empty;
    const models = query.sourceModels ? Prisma.sql`AND "sourceModel" = ANY(${[...query.sourceModels]}::text[])` : Prisma.empty;
    return Prisma.sql`
        SELECT "sourceModel", "sourceId", "chunkIndex", "bookId", "contentHash", 1 - ${distance} AS score
        FROM ${TABLE}
        WHERE "workspaceId" = ${workspaceId}
          AND "embeddingRevision" = ${query.embeddingRevision}
          ${book}
          ${models}
        ORDER BY ${distance}, "sourceModel" COLLATE "C", "sourceId" COLLATE "C", "chunkIndex"
        LIMIT ${query.k}`;
}

type SearchRow = {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    bookId: string | null;
    contentHash: string;
    score: number;
};
type KeyRow = {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    bookId: string | null;
    contentHash: string;
    dimensions: number;
};

function toStored(embeddingRevision: string, r: KeyRow): StoredVectorKey {
    return {
        sourceModel: r.sourceModel,
        sourceId: r.sourceId,
        chunkIndex: Number(r.chunkIndex),
        embeddingRevision,
        bookId: r.bookId,
        contentHash: r.contentHash,
        dimensions: Number(r.dimensions),
    };
}

export function createPgvectorStore(): VectorStoreBackend {
    let installed = false;

    /**
     * Before every statement: the transaction is `runInWorkspaceContext`'s for
     * THIS workspace, and (once per process) the extension and table exist.
     */
    async function assertReady(db: VectorDb, workspaceId: string): Promise<void> {
        const [probe] = await db.$queryRaw<Array<{ role: string | null; bound: string | null; ver: string | null; tbl: boolean }>>(Prisma.sql`
            SELECT current_setting('role', true) AS role,
                   current_setting('app.workspace_id', true) AS bound,
                   (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS ver,
                   to_regclass('"VectorEmbedding"') IS NOT NULL AS tbl`);
        if (probe?.role !== 'app_user' || probe.bound !== workspaceId) {
            throw new VectorStoreError(
                'NOT_IN_WORKSPACE_CONTEXT',
                "the vector store runs only inside runInWorkspaceContext for the workspace it names",
            );
        }
        if (installed) return;
        if (!probe.ver) {
            throw new VectorStoreError('PGVECTOR_NOT_INSTALLED', 'the vector extension is not installed in this database');
        }
        if (!versionAtLeast(probe.ver, MIN_PGVECTOR_VERSION)) {
            throw new VectorStoreError(
                'PGVECTOR_NOT_INSTALLED',
                `the vector extension is ${probe.ver}; the store needs ${MIN_PGVECTOR_VERSION.join('.')}+`,
            );
        }
        if (!probe.tbl) {
            throw new VectorStoreError('PGVECTOR_NOT_INSTALLED', 'the embedding table does not exist; its migration has not run');
        }
        installed = true;
    }

    /** The dimension count the workspace's rows of a revision hold, or null when it has none. */
    async function revisionDimensions(db: VectorDb, workspaceId: string, embeddingRevision: string): Promise<number | null> {
        const rows = await db.$queryRaw<Array<{ dimensions: number }>>(Prisma.sql`
            SELECT DISTINCT "dimensions" FROM ${TABLE}
            WHERE "workspaceId" = ${workspaceId} AND "embeddingRevision" = ${embeddingRevision}
            LIMIT 2`);
        if (rows.length > 1) {
            throw new VectorStoreError(
                'REVISION_DIMENSION_MISMATCH',
                `revision ${embeddingRevision} holds vectors of more than one dimension count`,
            );
        }
        return rows.length === 0 ? null : Number(rows[0].dimensions);
    }

    async function writeBatch(
        db: VectorDb,
        workspaceId: string,
        records: readonly VectorRecord[],
        generation: string | null,
    ): Promise<UpsertOutcome> {
        if (records.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
        // The repository admits one revision and one dimension count per call.
        const { embeddingRevision, embedding } = records[0];
        const [iso] = await db.$queryRaw<Array<{ iso: string }>>(Prisma.sql`SELECT current_setting('transaction_isolation') AS iso`);
        if (iso?.iso !== VECTOR_WRITE_ISOLATION) {
            throw new VectorStoreError('UNSUPPORTED_ISOLATION', `vector writes need ${VECTOR_WRITE_ISOLATION} isolation, not ${iso?.iso ?? 'unknown'}`);
        }
        // Shared with every other write; a rebuild's start takes it exclusively,
        // so no write's writeSeq can fall below a startSeq drawn while it is in flight.
        // `void` cannot be deserialised by $queryRaw, hence $executeRaw.
        await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(${lockKey(workspaceId, embeddingRevision)})`);
        let stored = await revisionDimensions(db, workspaceId, embeddingRevision);
        if (stored === null) {
            // The revision's FIRST write in this workspace fixes its dimension
            // count, and two of them may race: each sees no rows (the other's
            // are uncommitted), and under the shared lock alone both would
            // commit, leaving a revision of two counts that every later call
            // refuses. So a first write takes the revision's first-write lock
            // (held to commit) and asks again: a second first write waits for
            // the first to commit and then sees its rows. Taken after the shared
            // lock and never before it, so it cannot deadlock with a rebuild.
            await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${firstWriteLockKey(workspaceId)})`);
            stored = await revisionDimensions(db, workspaceId, embeddingRevision);
        }
        if (stored !== null && stored !== embedding.length) {
            throw new VectorStoreError('REVISION_DIMENSION_MISMATCH', `revision ${embeddingRevision} holds ${stored}-dimensional vectors`);
        }

        // What each key holds already, for the outcome counts. Narrowed by
        // source id first; the exact key is matched in memory.
        const sourceIds = [...new Set(records.map((r) => r.sourceId))];
        const prior = await db.$queryRaw<Array<{ sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; bookId: string | null }>>(
            Prisma.sql`
                SELECT "sourceModel", "sourceId", "chunkIndex", "contentHash", "bookId" FROM ${TABLE}
                WHERE "workspaceId" = ${workspaceId}
                  AND "embeddingRevision" = ${embeddingRevision}
                  AND "sourceId" = ANY(${sourceIds}::text[])`,
        );
        const byKey = new Map(prior.map((p) => [keyOf({ ...p, chunkIndex: Number(p.chunkIndex), embeddingRevision }), p]));

        const values = records.map(
            (r) => Prisma.sql`(
                ${randomUUID()}, ${workspaceId}, ${r.bookId}, ${r.sourceModel}, ${r.sourceId}, ${r.chunkIndex},
                ${r.embeddingRevision}, ${r.embedding.length}, ${r.contentHash}, ${vectorLiteral(r.embedding)}::vector,
                ${generation}, now())`,
        );
        // Same hash: the stored vector already describes this text, so it is
        // kept (and `updatedAt` with it); a moved scope is still rewritten.
        // RETURNING names every row the statement wrote: a row a source guard
        // skipped (`vector_embedding_require_source` returns NULL for a
        // rebuild's vector whose source is gone) is not among them, so it is
        // counted as nothing, never as inserted.
        const written = await db.$queryRaw<Array<{ sourceModel: string; sourceId: string; chunkIndex: number }>>(Prisma.sql`
            INSERT INTO ${TABLE} (
                "id", "workspaceId", "bookId", "sourceModel", "sourceId", "chunkIndex",
                "embeddingRevision", "dimensions", "contentHash", "embedding",
                "rebuildGeneration", "updatedAt")
            VALUES ${Prisma.join(values)}
            ON CONFLICT ("workspaceId", "embeddingRevision", "sourceModel", "sourceId", "chunkIndex")
            DO UPDATE SET
                "embedding" = CASE WHEN ${TABLE}."contentHash" = EXCLUDED."contentHash"
                                   THEN ${TABLE}."embedding" ELSE EXCLUDED."embedding" END,
                "dimensions" = EXCLUDED."dimensions",
                "contentHash" = EXCLUDED."contentHash",
                "bookId" = EXCLUDED."bookId",
                "rebuildGeneration" = COALESCE(EXCLUDED."rebuildGeneration", ${TABLE}."rebuildGeneration"),
                "writeSeq" = EXCLUDED."writeSeq",
                "updatedAt" = CASE WHEN ${TABLE}."contentHash" = EXCLUDED."contentHash"
                                    AND ${TABLE}."bookId" IS NOT DISTINCT FROM EXCLUDED."bookId"
                                   THEN ${TABLE}."updatedAt" ELSE now() END
            RETURNING "sourceModel", "sourceId", "chunkIndex"`);

        const counted: UpsertOutcome = { inserted: 0, updated: 0, unchanged: 0 };
        const recordByKey = new Map(records.map((r) => [keyOf(r), r]));
        for (const w of written) {
            const key = keyOf({ ...w, chunkIndex: Number(w.chunkIndex), embeddingRevision });
            const r = recordByKey.get(key);
            if (!r) continue;
            const p = byKey.get(key);
            if (!p) counted.inserted++;
            else if (p.contentHash === r.contentHash && p.bookId === r.bookId) counted.unchanged++;
            else counted.updated++;
        }
        return counted;
    }

    return {
        kind: 'pgvector',

        async upsert(db, workspaceId, records) {
            await assertReady(db, workspaceId);
            return writeBatch(db, workspaceId, records, null);
        },

        async search(db, workspaceId, query): Promise<VectorMatch[]> {
            await assertReady(db, workspaceId);
            const stored = await revisionDimensions(db, workspaceId, query.embeddingRevision);
            if (stored === null) return [];
            if (stored !== query.embedding.length) {
                throw new VectorStoreError('DIMENSION_MISMATCH', `revision ${query.embeddingRevision} holds ${stored}-dimensional vectors`);
            }
            const rows = await db.$queryRaw<SearchRow[]>(buildSearchQuery(workspaceId, query, stored));
            // How large the scan was, counted no further than the threshold (the
            // btree answers it): past it, the revision wants its HNSW index.
            const [{ n }] = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
                SELECT count(*)::int AS n FROM (
                    SELECT 1 FROM ${TABLE}
                    WHERE "workspaceId" = ${workspaceId} AND "embeddingRevision" = ${query.embeddingRevision}
                    LIMIT ${EXACT_SCAN_WARN_ROWS + 1}) s`);
            if (Number(n) > EXACT_SCAN_WARN_ROWS) {
                logger.warn('vector_store.search_large_exact_scan', {
                    component: 'vector-store',
                    workspaceId,
                    rowsAtLeast: EXACT_SCAN_WARN_ROWS + 1,
                });
            }
            return rows.map((r) => ({
                sourceModel: r.sourceModel,
                sourceId: r.sourceId,
                chunkIndex: Number(r.chunkIndex),
                bookId: r.bookId,
                contentHash: r.contentHash,
                score: Number(r.score),
            }));
        },

        async listKeys(db, workspaceId, embeddingRevision, limit): Promise<StoredVectorKey[]> {
            await assertReady(db, workspaceId);
            const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`
                SELECT "sourceModel", "sourceId", "chunkIndex", "bookId", "contentHash", "dimensions"
                FROM ${TABLE}
                WHERE "workspaceId" = ${workspaceId} AND "embeddingRevision" = ${embeddingRevision}
                ORDER BY "sourceModel" COLLATE "C", "sourceId" COLLATE "C", "chunkIndex"
                LIMIT ${limit}`);
            return rows.map((r) => toStored(embeddingRevision, r));
        },

        async listSourceKeys(db, workspaceId, embeddingRevision, sourceModel, sourceId, limit): Promise<StoredVectorKey[]> {
            await assertReady(db, workspaceId);
            const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`
                SELECT "sourceModel", "sourceId", "chunkIndex", "bookId", "contentHash", "dimensions"
                FROM ${TABLE}
                WHERE "workspaceId" = ${workspaceId} AND "embeddingRevision" = ${embeddingRevision}
                  AND "sourceModel" = ${sourceModel} AND "sourceId" = ${sourceId}
                ORDER BY "chunkIndex"
                LIMIT ${limit}`);
            return rows.map((r) => toStored(embeddingRevision, r));
        },

        async deleteSource(db, workspaceId, sourceModel, sourceId) {
            await assertReady(db, workspaceId);
            return db.$executeRaw(Prisma.sql`
                DELETE FROM ${TABLE}
                WHERE "workspaceId" = ${workspaceId} AND "sourceModel" = ${sourceModel} AND "sourceId" = ${sourceId}`);
        },

        async rebuildRevision(inWorkspace, workspaceId, embeddingRevision, batches): Promise<RebuildOutcome & { seen: number }> {
            // One transaction per batch, so a large workspace never holds one
            // long transaction. Rows are stamped with this rebuild's
            // generation; only after the LAST batch are the revision's rows
            // with any other generation, written before this rebuild began,
            // deleted. A source that throws first leaves a superset, which a
            // caller reading hits back through their source rows tolerates.
            const generation = randomUUID();
            // Drawn under the exclusive lock BEFORE the source is read: every
            // write committed earlier has writeSeq < startSeq, every later one
            // has more, and only the former can be judged by this source.
            const startSeq = await inWorkspace(async (db) => {
                await assertReady(db, workspaceId);
                await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lockKey(workspaceId, embeddingRevision)})`);
                const rows = await db.$queryRaw<Array<{ seq: bigint | number | string }>>(Prisma.sql`SELECT nextval(${WRITE_SEQ}::regclass) AS seq`);
                return BigInt(rows[0].seq);
            });
            const outcome: RebuildOutcome = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
            let seen = 0;
            for await (const batch of batches) {
                // Counted once the batch's transaction has committed, from the
                // rows its statement wrote: a rolled-back batch counts nothing,
                // and a vector the source guard skipped is not "inserted".
                const counted = await inWorkspace(async (db) => {
                    await assertReady(db, workspaceId);
                    return writeBatch(db, workspaceId, batch, generation);
                });
                outcome.inserted += counted.inserted;
                outcome.updated += counted.updated;
                outcome.unchanged += counted.unchanged;
                seen += batch.length;
            }
            outcome.deleted = await inWorkspace(async (db) => {
                await assertReady(db, workspaceId);
                return db.$executeRaw(Prisma.sql`
                    DELETE FROM ${TABLE}
                    WHERE "workspaceId" = ${workspaceId}
                      AND "embeddingRevision" = ${embeddingRevision}
                      AND "rebuildGeneration" IS DISTINCT FROM ${generation}
                      AND "writeSeq" < ${startSeq}`);
            });
            return { ...outcome, seen };
        },
    };
}
