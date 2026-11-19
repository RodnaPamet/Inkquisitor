/**
 * The embedding seam (subphase 2.0). Server-only: the TEI provider dials an
 * address inside the deployment, and nowhere else.
 *
 * Callers embed with `getEmbeddingProvider()`, hash the same text with
 * `vectorContentHash`, and file the vectors through the vector store
 * (`src/app-layer/repositories/vector.repository.ts`) under the provider's
 * `revision`.
 *
 * @module lib/ai/embeddings
 */
export * from './types';
export { getEmbeddingProvider } from './select';
export type { EmbeddingProviderChoice } from './select';
export { resolveEmbeddingConfig, embeddingConfigProblems, MAX_EMBEDDING_DIMENSIONS } from './config';
export type { EmbeddingConfig, EmbeddingConfigRefusal, TeiRoute } from './config';
export { StubEmbeddingProvider, STUB_EMBEDDING_MODEL, STUB_DEFAULT_DIMENSIONS, stubVector } from './stub-provider';
export { TeiEmbeddingProvider } from './tei-provider';
export { embeddingRevisionOf, EMBEDDING_REVISION_PATTERN, InvalidEmbeddingRevisionError } from './revision';
export type { EmbeddingSpace } from './revision';
export { vectorContentHash } from './content-hash';
export type { EmbeddingOutcome } from './metrics';
