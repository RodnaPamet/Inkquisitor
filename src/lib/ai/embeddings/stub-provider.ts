/**
 * The deterministic embedding stub — the provider of development and test
 * (`EMBEDDING_PROVIDER` unset or `stub`), never of production
 * (`src/lib/startup-checks.ts` refuses it there, and `select.ts` will not
 * build it).
 *
 * Carved from inflect-compliance's `src/lib/ai/embeddings/stub-provider.ts`
 * (docs/carve-manifest.md). Inflect's factory never chose the stub, because a
 * stub vector written into an index is a passage no real model can find
 * again. Inkquisitor's revision closes that hole instead: the stub's vectors
 * are filed under the stub's own revision (`stub-feature-hash@1:d64:…`), and
 * the store never compares two revisions, so a stub vector cannot be found by,
 * or mistaken for, a real one. The rerank stub is not carried.
 *
 * It is FEATURE HASHING, not random bytes: each lower-cased word is hashed
 * into a signed bucket and the vector is L2-normalised, so two texts sharing
 * words have a positive cosine. That gives a dedupe or retrieval test a signal
 * to assert on, with no model, no network and no randomness — the same text
 * always yields the same vector, on every machine.
 *
 * @module lib/ai/embeddings/stub-provider
 */
import { createHash } from 'node:crypto';

import { embeddingRevisionOf } from './revision';
import { EMBEDDING_PROVIDER_IDS, MAX_EMBED_BATCH, type EmbedOptions, type EmbeddingProvider, type EmbeddingResult } from './types';

export const STUB_EMBEDDING_MODEL = 'stub-feature-hash@1';
export const STUB_DEFAULT_DIMENSIONS = 64;

function words(text: string): string[] {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function bucketOf(word: string, dimensions: number): { index: number; sign: 1 | -1 } {
    const digest = createHash('sha256').update(word).digest();
    return { index: digest.readUInt32BE(0) % dimensions, sign: digest[4] & 1 ? 1 : -1 };
}

/** The stub's vector for one text: feature-hashed and L2-normalised (all-zero for no words). */
export function stubVector(text: string, dimensions: number): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const word of words(text)) {
        const { index, sign } = bucketOf(word, dimensions);
        vector[index] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
}

export class StubEmbeddingProvider implements EmbeddingProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.stub;
    readonly model = STUB_EMBEDDING_MODEL;
    readonly revision: string;

    constructor(readonly dimensions: number = STUB_DEFAULT_DIMENSIONS) {
        this.revision = embeddingRevisionOf({ model: this.model, dimensions, queryPrefix: '', passagePrefix: '' });
    }

    // The options (the input type) are deliberately not read: a symmetric stub
    // gives a test a fixed point to compare a real asymmetric model against.
    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        void opts;
        if (texts.length === 0) return { ok: false, reason: 'EMPTY_INPUT' };
        if (texts.length > MAX_EMBED_BATCH) return { ok: false, reason: 'BATCH_TOO_LARGE' };
        return {
            ok: true,
            vectors: texts.map((t) => stubVector(t, this.dimensions)),
            model: this.model,
            dimensions: this.dimensions,
            revision: this.revision,
        };
    }
}
