/**
 * The in-process vector backend: a reference implementation, held in memory.
 *
 * It is what the unit tests run the repository's behaviour against, and the
 * statement of what the pgvector backend must do. It is NEVER selected by
 * `getVectorRepository()` — the product always has pgvector (the 2.0
 * migration creates the extension) — so nothing a workspace writes ever lands
 * in a process's heap and disappears on restart while looking stored.
 *
 * Carved from inflect-compliance's
 * `src/app-layer/repositories/vector/in-process-store.ts`
 * (docs/carve-manifest.md): tenant → workspace, the backend contract's
 * transaction argument (ignored here), the book scope, and no tenant-wide
 * delete.
 *
 * Isolation here is by construction: rows are filed under the workspace id,
 * and every method reads only that workspace's map.
 *
 * Every write stamps the row with the next value of a store-wide write
 * sequence (the pgvector backend's `writeSeq`). A rebuild notes the sequence
 * when it starts and, at the end, deletes only rows it did not stamp that
 * were last written BEFORE it started — so an upsert or another rebuild
 * landing between its batches is never erased by it.
 */
import {
    compareKeys,
    cosineSimilarity,
    keyOf,
    VectorStoreError,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './types';

interface Row {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    embeddingRevision: string;
    bookId: string | null;
    contentHash: string;
    embedding: readonly number[];
    /** The rebuild that last wrote or confirmed the row; 0 for a plain upsert's new row. */
    generation: number;
    /** When the row was last written or confirmed, on the store's write sequence. */
    writeSeq: number;
}

function stored(r: Row): StoredVectorKey {
    return {
        sourceModel: r.sourceModel,
        sourceId: r.sourceId,
        chunkIndex: r.chunkIndex,
        embeddingRevision: r.embeddingRevision,
        bookId: r.bookId,
        contentHash: r.contentHash,
        dimensions: r.embedding.length,
    };
}

export function createInProcessVectorStore(): VectorStoreBackend {
    const workspaces = new Map<string, Map<string, Row>>();
    let generationCounter = 0;
    let writeSeq = 0;

    function rowsOf(workspaceId: string): Map<string, Row> {
        let rows = workspaces.get(workspaceId);
        if (!rows) {
            rows = new Map();
            workspaces.set(workspaceId, rows);
        }
        return rows;
    }

    function assertRevisionDimensions(rows: Map<string, Row>, record: VectorRecord): void {
        for (const row of rows.values()) {
            if (row.embeddingRevision === record.embeddingRevision && row.embedding.length !== record.embedding.length) {
                throw new VectorStoreError(
                    'REVISION_DIMENSION_MISMATCH',
                    `revision ${record.embeddingRevision} holds ${row.embedding.length}-dimensional vectors`,
                );
            }
        }
    }

    function write(rows: Map<string, Row>, records: readonly VectorRecord[], generation: number | null, outcome: UpsertOutcome): void {
        for (const record of records) assertRevisionDimensions(rows, record);
        for (const record of records) {
            const key = keyOf(record);
            const existing = rows.get(key);
            if (existing && existing.contentHash === record.contentHash && existing.bookId === record.bookId) {
                if (generation !== null) existing.generation = generation;
                existing.writeSeq = ++writeSeq;
                outcome.unchanged++;
                continue;
            }
            rows.set(key, {
                sourceModel: record.sourceModel,
                sourceId: record.sourceId,
                chunkIndex: record.chunkIndex,
                embeddingRevision: record.embeddingRevision,
                bookId: record.bookId,
                contentHash: record.contentHash,
                // Same hash, new scope: the vector already describes this text.
                embedding: existing && existing.contentHash === record.contentHash ? existing.embedding : [...record.embedding],
                generation: generation ?? existing?.generation ?? 0,
                writeSeq: ++writeSeq,
            });
            if (existing) outcome.updated++;
            else outcome.inserted++;
        }
    }

    return {
        kind: 'in-process',

        async upsert(_db, workspaceId, records) {
            const outcome: UpsertOutcome = { inserted: 0, updated: 0, unchanged: 0 };
            write(rowsOf(workspaceId), records, null, outcome);
            return outcome;
        },

        async search(_db, workspaceId, query: VectorSearchQuery): Promise<VectorMatch[]> {
            const rows = workspaces.get(workspaceId);
            if (!rows) return [];
            const models = query.sourceModels ? new Set(query.sourceModels) : null;
            const hits: VectorMatch[] = [];
            for (const row of rows.values()) {
                if (row.embeddingRevision !== query.embeddingRevision) continue;
                if (query.bookId !== undefined && row.bookId !== query.bookId) continue;
                if (models && !models.has(row.sourceModel)) continue;
                if (row.embedding.length !== query.embedding.length) {
                    throw new VectorStoreError(
                        'DIMENSION_MISMATCH',
                        `revision ${query.embeddingRevision} holds ${row.embedding.length}-dimensional vectors`,
                    );
                }
                hits.push({
                    sourceModel: row.sourceModel,
                    sourceId: row.sourceId,
                    chunkIndex: row.chunkIndex,
                    bookId: row.bookId,
                    contentHash: row.contentHash,
                    score: cosineSimilarity(row.embedding, query.embedding),
                });
            }
            hits.sort((a, b) => b.score - a.score || compareKeys(a, b));
            return hits.slice(0, query.k);
        },

        async listKeys(_db, workspaceId, embeddingRevision, limit): Promise<StoredVectorKey[]> {
            const rows = workspaces.get(workspaceId);
            if (!rows) return [];
            return [...rows.values()]
                .filter((r) => r.embeddingRevision === embeddingRevision)
                .sort(compareKeys)
                .slice(0, limit)
                .map(stored);
        },

        async listSourceKeys(_db, workspaceId, embeddingRevision, sourceModel, sourceId, limit): Promise<StoredVectorKey[]> {
            const rows = workspaces.get(workspaceId);
            if (!rows) return [];
            return [...rows.values()]
                .filter((r) => r.embeddingRevision === embeddingRevision && r.sourceModel === sourceModel && r.sourceId === sourceId)
                .sort(compareKeys)
                .slice(0, limit)
                .map(stored);
        },

        async deleteSource(_db, workspaceId, sourceModel, sourceId) {
            const rows = workspaces.get(workspaceId);
            if (!rows) return 0;
            let deleted = 0;
            for (const [key, row] of rows) {
                if (row.sourceModel === sourceModel && row.sourceId === sourceId) {
                    rows.delete(key);
                    deleted++;
                }
            }
            return deleted;
        },

        async rebuildRevision(_inWorkspace, workspaceId, embeddingRevision, batches): Promise<RebuildOutcome & { seen: number }> {
            const generation = ++generationCounter;
            const startSeq = writeSeq;
            const rows = rowsOf(workspaceId);
            const outcome: RebuildOutcome = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
            let seen = 0;
            for await (const batch of batches) {
                write(rows, batch, generation, outcome);
                seen += batch.length;
            }
            for (const [key, row] of rows) {
                if (row.embeddingRevision === embeddingRevision && row.generation !== generation && row.writeSeq <= startSeq) {
                    rows.delete(key);
                    outcome.deleted++;
                }
            }
            return { ...outcome, seen };
        },
    };
}
