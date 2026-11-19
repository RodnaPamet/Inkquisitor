/**
 * The embedding seam — the contract every embedding provider speaks, and the
 * vector store's callers (2.1 question dedupe, 4.1 elements, facts and
 * answers) embed through.
 *
 * Carved from inflect-compliance's `src/lib/ai/embeddings/types.ts`
 * (docs/carve-manifest.md). The rerank half is not carried: nothing in the
 * roadmap reranks. Two rules shape every type here:
 *
 *   • A call DEGRADES rather than throws. Every failure is a named value in the
 *     result, so an index job can count it, a dedupe can fall back to its
 *     normalised-text comparison, and nothing is mistaken for "no results".
 *   • The vector space is NAMED. A provider carries its `revision`
 *     (`embeddingRevisionOf`): the model, the dimension count and the prompt
 *     prefixes. The store files every vector under it and never compares two
 *     revisions, so a stub vector can never be searched against a real one.
 *
 * The model is CONFIGURATION, not code: nothing in this directory names a
 * production model.
 *
 * @module lib/ai/embeddings/types
 */

/** Provider ids. `stub` is development and test only (production refuses it). */
export const EMBEDDING_PROVIDER_IDS = {
    /** Text Embeddings Inference, a service INSIDE the deployment. */
    tei: 'tei',
    /** The deterministic stub: feature hashing, no network. */
    stub: 'stub',
} as const;

export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[keyof typeof EMBEDDING_PROVIDER_IDS];

/**
 * Asymmetric retrieval models score a query and a passage differently. Mixing
 * them silently degrades recall, which is why the input type is REQUIRED on
 * every call rather than defaulted.
 */
export type EmbeddingInputType = 'query' | 'passage';

/** At most this many texts per `embed` call. */
export const MAX_EMBED_BATCH = 64;

/**
 * Why a call produced nothing. Each is an outcome label on
 * `embeddings.requests`, lower-cased.
 */
export type EmbeddingFailure =
    /** No texts. Nothing was sent. */
    | 'EMPTY_INPUT'
    /** More than the per-call bound. Nothing was sent. */
    | 'BATCH_TOO_LARGE'
    /** The request body would exceed its byte cap. Nothing was sent. */
    | 'INPUT_TOO_LARGE'
    /**
     * The endpoint is, or resolves to, an address outside the deployment
     * (`src/lib/ai/in-deployment-service.ts`). Nothing was sent.
     */
    | 'ENDPOINT_OUTSIDE_PERIMETER'
    /** The service answered with a redirect, which is never followed. */
    | 'REDIRECT_REFUSED'
    /** The deadline passed before the whole body was read. */
    | 'TIMEOUT'
    /** The caller's own signal aborted the call. */
    | 'ABORTED'
    /** The service answered with a non-2xx status. */
    | 'HTTP_STATUS'
    /** The response body passed its byte cap. Reading was aborted at the cap. */
    | 'RESPONSE_TOO_LARGE'
    /** The body was not the shape the service's API defines. */
    | 'MALFORMED_RESPONSE'
    /** A different number of vectors than texts sent, or a repeated index. */
    | 'COUNT_MISMATCH'
    /** A vector of a different length than the configured dimension. */
    | 'DIMENSION_MISMATCH'
    /**
     * The service did not report serving the configured model — it named
     * another, or none. TEI serves one model per process whatever a request
     * asks for, so what it SAYS it served is the only binding between the
     * model id on a result (and in the revision) and the vectors.
     */
    | 'SERVED_MODEL_MISMATCH'
    /** The connection failed before an answer. */
    | 'NETWORK_ERROR';

export type EmbeddingResult =
    | {
          readonly ok: true;
          /** One vector per input text, in input order. */
          readonly vectors: readonly (readonly number[])[];
          readonly model: string;
          readonly dimensions: number;
          /** The vector space the vectors belong to; the store's `embeddingRevision`. */
          readonly revision: string;
      }
    | { readonly ok: false; readonly reason: EmbeddingFailure; readonly status?: number };

export interface EmbedOptions {
    readonly inputType: EmbeddingInputType;
    /** The caller's own cancellation; the provider's deadline applies regardless. */
    readonly signal?: AbortSignal;
}

export interface EmbeddingProvider {
    readonly providerId: EmbeddingProviderId;
    readonly model: string;
    readonly dimensions: number;
    /** `embeddingRevisionOf(model, dimensions, prefixes)`: the store's `embeddingRevision`. */
    readonly revision: string;
    embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult>;
}
