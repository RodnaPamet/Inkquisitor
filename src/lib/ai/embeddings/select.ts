/**
 * The embedding factory: the deployment's provider, or the named reason there
 * is none. The ONE module that reads the `EMBEDDING_*` variables from `env`;
 * their meaning is `config.ts`'s, which the production start-up check reads
 * too.
 *
 * Adapted from inflect-compliance's `src/lib/ai/embeddings/select.ts`
 * (docs/carve-manifest.md): no residency branches (one route, the
 * deployment's own), no reranker, and the stub is the development and test
 * default rather than never chosen (its vectors live under their own revision;
 * see `stub-provider.ts`).
 *
 * A refusal constructs NOTHING. The provider is built per call and holds no
 * state worth caching.
 *
 * @module lib/ai/embeddings/select
 */
import { env } from '@/env';

import { resolveEmbeddingConfig, type EmbeddingConfigRefusal } from './config';
import { StubEmbeddingProvider } from './stub-provider';
import { TeiEmbeddingProvider } from './tei-provider';
import type { EmbeddingProvider } from './types';

export type EmbeddingProviderChoice =
    | { readonly ok: true; readonly provider: EmbeddingProvider }
    | { readonly ok: false; readonly reason: EmbeddingConfigRefusal; readonly detail?: string };

export function getEmbeddingProvider(): EmbeddingProviderChoice {
    const config = resolveEmbeddingConfig({
        NODE_ENV: env.NODE_ENV,
        EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER,
        EMBEDDING_TEI_BASE_URL: env.EMBEDDING_TEI_BASE_URL,
        EMBEDDING_TEI_MODEL: env.EMBEDDING_TEI_MODEL,
        EMBEDDING_TEI_DIMENSIONS: env.EMBEDDING_TEI_DIMENSIONS,
        EMBEDDING_TEI_QUERY_PREFIX: env.EMBEDDING_TEI_QUERY_PREFIX,
        EMBEDDING_TEI_PASSAGE_PREFIX: env.EMBEDDING_TEI_PASSAGE_PREFIX,
    });
    if (!config.ok) return config;
    if (config.provider === 'stub') return { ok: true, provider: new StubEmbeddingProvider() };
    return { ok: true, provider: new TeiEmbeddingProvider(config.tei) };
}
