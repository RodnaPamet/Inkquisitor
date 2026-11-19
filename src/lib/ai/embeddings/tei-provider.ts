/**
 * Hugging Face Text Embeddings Inference (TEI), inside the deployment — the
 * production embedding provider.
 *
 *   embed → POST <base>/v1/embeddings   (TEI's OpenAI-compatible route)
 *
 * Carved from inflect-compliance's `src/lib/ai/embeddings/tei-provider.ts`
 * (docs/carve-manifest.md): the reranker and the residency specifier are not
 * carried. Self-hosted TEI is why author text reaches no new sub-processor:
 * the request goes through {@link postJsonBounded}, which dials only through
 * the shared in-deployment rule (`src/lib/ai/in-deployment-service.ts`) —
 * every resolved address inside the deployment and pinned, a deadline, a byte
 * cap that aborts. The base URL is OPERATOR configuration (`config.ts`);
 * nothing a workspace writes reaches it. No model is named in code.
 *
 * ── THE MODEL THAT ANSWERED IS CHECKED ──────────────────────────────────────
 *
 * TEI serves ONE model per process: `/v1/embeddings` ignores the request's
 * `model`. A container moved to another model of the same dimension would
 * answer every call `ok`, under the configured id, and its vectors would land
 * under the configured REVISION beside the old model's, where cosine between
 * them means nothing. So the id a result carries must be the id the SERVICE
 * reports in the response's `model` (TEI writes its `model_id` there). Absent
 * or different is `SERVED_MODEL_MISMATCH`, and the answer is refused whole.
 * The comparison is exact: the operator names the model as TEI's
 * `--model-id` names it.
 *
 * Texts are never logged; a failure logs its reason, the model, and the count
 * of texts.
 *
 * @module lib/ai/embeddings/tei-provider
 */
import { z } from 'zod';

import { logger } from '@/lib/observability/logger';

import type { TeiRoute } from './config';
import { postJsonBounded, type BoundedPostFailure } from './http';
import { outcomeOf, recordEmbeddingRequest } from './metrics';
import {
    EMBEDDING_PROVIDER_IDS,
    MAX_EMBED_BATCH,
    type EmbedOptions,
    type EmbeddingFailure,
    type EmbeddingProvider,
    type EmbeddingResult,
} from './types';

/** Each call's deadline, covering DNS, the response head and the body read. */
export const TEI_DEADLINE_MS = 15_000;
/** The largest request body sent. */
export const TEI_MAX_REQUEST_BYTES = 1024 * 1024;
/** 64 vectors × 4096 floats as JSON is about 6.5 MB; 8 MiB is the ceiling. */
export const TEI_MAX_EMBED_RESPONSE_BYTES = 8 * 1024 * 1024;

const embeddingsResponseSchema = z.object({
    // Optional in the SCHEMA so its absence is reported as the model question
    // it is (SERVED_MODEL_MISMATCH), not as a malformed body.
    model: z.string().optional(),
    data: z.array(
        z.object({
            index: z.number().int().nonnegative(),
            embedding: z.array(z.number()),
        }),
    ),
});

function endpoint(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function transportFailure(r: { reason: BoundedPostFailure; status?: number }): {
    ok: false;
    reason: EmbeddingFailure;
    status?: number;
} {
    return r.status === undefined ? { ok: false, reason: r.reason } : { ok: false, reason: r.reason, status: r.status };
}

export class TeiEmbeddingProvider implements EmbeddingProvider {
    readonly providerId = EMBEDDING_PROVIDER_IDS.tei;
    readonly model: string;
    readonly dimensions: number;
    readonly revision: string;

    constructor(private readonly route: TeiRoute) {
        this.model = route.model;
        this.dimensions = route.dimensions;
        this.revision = route.revision;
    }

    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        const started = Date.now();
        const done = (result: EmbeddingResult): EmbeddingResult => {
            recordEmbeddingRequest({
                provider: this.providerId,
                outcome: outcomeOf(result.ok ? null : result.reason),
                durationMs: Date.now() - started,
            });
            if (!result.ok) {
                logger.warn('embeddings.request_failed', {
                    component: 'embeddings',
                    provider: this.providerId,
                    model: this.model,
                    reason: result.reason,
                    status: result.status,
                    count: texts.length,
                });
            }
            return result;
        };

        if (texts.length === 0) return done({ ok: false, reason: 'EMPTY_INPUT' });
        if (texts.length > MAX_EMBED_BATCH) return done({ ok: false, reason: 'BATCH_TOO_LARGE' });

        const prefix = opts.inputType === 'query' ? this.route.queryPrefix : this.route.passagePrefix;
        const body = JSON.stringify({
            model: this.model,
            input: texts.map((t) => `${prefix}${t}`),
            encoding_format: 'float',
        });
        if (Buffer.byteLength(body, 'utf8') > TEI_MAX_REQUEST_BYTES) return done({ ok: false, reason: 'INPUT_TOO_LARGE' });

        const res = await postJsonBounded(endpoint(this.route.baseUrl, '/v1/embeddings'), body, {
            service: 'embed',
            deadlineMs: TEI_DEADLINE_MS,
            maxResponseBytes: TEI_MAX_EMBED_RESPONSE_BYTES,
            signal: opts.signal,
        });
        if (!res.ok) return done(transportFailure(res));

        const parsed = embeddingsResponseSchema.safeParse(res.json);
        if (!parsed.success) return done({ ok: false, reason: 'MALFORMED_RESPONSE' });
        // The model that ANSWERED, not the one asked for (module header).
        if (parsed.data.model !== this.model) return done({ ok: false, reason: 'SERVED_MODEL_MISMATCH' });

        // Exactly one vector per text, each index once, each of the configured
        // dimension. A short answer is not a partial success: a missing vector
        // is a text nobody can find.
        const rows = parsed.data.data;
        if (rows.length !== texts.length) return done({ ok: false, reason: 'COUNT_MISMATCH' });
        const vectors: (readonly number[])[] = new Array<readonly number[]>(texts.length);
        const seen = new Set<number>();
        for (const row of rows) {
            if (row.index >= texts.length || seen.has(row.index)) return done({ ok: false, reason: 'COUNT_MISMATCH' });
            if (row.embedding.length !== this.dimensions) return done({ ok: false, reason: 'DIMENSION_MISMATCH' });
            seen.add(row.index);
            vectors[row.index] = row.embedding;
        }
        return done({ ok: true, vectors, model: this.model, dimensions: this.dimensions, revision: this.revision });
    }
}
