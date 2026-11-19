/**
 * The embedding revision — the name of a vector space, under which the vector
 * store files every vector (`VectorEmbedding.embeddingRevision`) and which a
 * search must name to compare against.
 *
 * Adapted from inflect-compliance's `src/lib/ai/embeddings/revision.ts`
 * (docs/carve-manifest.md), cut from its RAG retriever key (reranker, chunker,
 * k, index parameters: an evaluation record's concerns) to what changes the
 * vectors themselves:
 *
 *   `<model>:d<dimensions>:p<8 hex>`
 *
 * where the last part is the first 32 bits of the SHA-256 of the query and
 * passage prefixes (an instruction prefix moves every vector of an asymmetric
 * model). A change to ANY of them is a new revision, and the store never
 * compares two revisions, so the day the model changes, old vectors are
 * simply not found until a rebuild re-embeds them under the new revision.
 *
 * The revision names the MODEL, never the host it runs on: a TEI container
 * moved to another machine serving the same model writes the same space.
 *
 * @module lib/ai/embeddings/revision
 */
import { createHash } from 'node:crypto';

/**
 * What an `embeddingRevision` may look like: the store's validation, and the
 * table's CHECK, hold every stored revision to it.
 */
export const EMBEDDING_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export interface EmbeddingSpace {
    readonly model: string;
    readonly dimensions: number;
    readonly queryPrefix: string;
    readonly passagePrefix: string;
}

/** Thrown for a space no stored revision could name (a model id with spaces, a bad count). */
export class InvalidEmbeddingRevisionError extends Error {
    constructor(readonly field: keyof EmbeddingSpace | 'revision') {
        super(`Invalid embedding revision: ${field}`);
        this.name = 'InvalidEmbeddingRevisionError';
    }
}

/** The revision of a vector space; refuses a model or count the pattern cannot hold. */
export function embeddingRevisionOf(space: EmbeddingSpace): string {
    if (space.model.trim() === '' || space.model !== space.model.trim()) throw new InvalidEmbeddingRevisionError('model');
    if (!Number.isInteger(space.dimensions) || space.dimensions < 1) throw new InvalidEmbeddingRevisionError('dimensions');
    // A JSON array, so no prefix can forge the boundary between the two.
    const prefixes = createHash('sha256').update(JSON.stringify([space.queryPrefix, space.passagePrefix])).digest('hex').slice(0, 8);
    const revision = `${space.model}:d${space.dimensions}:p${prefixes}`;
    if (!EMBEDDING_REVISION_PATTERN.test(revision)) throw new InvalidEmbeddingRevisionError('revision');
    return revision;
}
