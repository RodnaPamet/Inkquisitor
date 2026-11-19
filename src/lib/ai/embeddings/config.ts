/**
 * WHICH EMBEDDING PROVIDER THIS DEPLOYMENT USES — the one interpretation of
 * the `EMBEDDING_*` variables, shared by the factory (`select.ts`, which hands
 * it `env`) and the production start-up check (`src/lib/startup-checks.ts`,
 * which hands it the process environment), so the two can never disagree.
 *
 * Adapted from the route half of inflect-compliance's
 * `src/lib/ai/embeddings/select.ts` (docs/carve-manifest.md). Inflect routes
 * by a tenant's residency; Inkquisitor has one route, the deployment's own:
 *
 *   stub   development and test (the default there). REFUSED in production.
 *   tei    Text Embeddings Inference at EMBEDDING_TEI_BASE_URL, which must
 *          name an address INSIDE the deployment (`checkPerimeterUrl`): the
 *          structural half is asked here, so a public literal, a metadata
 *          host or a URL carrying credentials is refused once, by name,
 *          before any text is queued for it; a NAME is judged again at use
 *          time by every address it resolves to (the dial).
 *
 * There is NO external embedding route. Adding one is a new sub-processor
 * receiving author text, which is an owner decision (D5 covers the model
 * provider only), so it is a reviewed diff here, never a configuration value.
 *
 * Pure: a function of the record it is given. No network, no `@/env`.
 *
 * @module lib/ai/embeddings/config
 */
import { checkPerimeterUrl } from '@/lib/ai/in-deployment-service';

import { embeddingRevisionOf, InvalidEmbeddingRevisionError } from './revision';

/** The largest dimension count a configured model may declare: the store's own bound. */
export const MAX_EMBEDDING_DIMENSIONS = 4096;

export interface TeiRoute {
    readonly baseUrl: string;
    readonly model: string;
    readonly dimensions: number;
    readonly queryPrefix: string;
    readonly passagePrefix: string;
    readonly revision: string;
}

export type EmbeddingConfigRefusal =
    /** Production, and EMBEDDING_PROVIDER is unset: there is no provider. */
    | 'EMBEDDING_NOT_CONFIGURED'
    /** Production, and EMBEDDING_PROVIDER=stub. */
    | 'STUB_IN_PRODUCTION'
    /** EMBEDDING_PROVIDER=tei without EMBEDDING_TEI_BASE_URL. */
    | 'TEI_URL_NOT_CONFIGURED'
    /** EMBEDDING_PROVIDER=tei without EMBEDDING_TEI_MODEL. */
    | 'TEI_MODEL_NOT_CONFIGURED'
    /** No dimension count, or one that is not an integer in 1..MAX_EMBEDDING_DIMENSIONS. */
    | 'TEI_DIMENSIONS_NOT_CONFIGURED'
    /** A model id no embedding revision can name (spaces, an odd character, too long). */
    | 'TEI_MODEL_INVALID'
    /** The base URL is not inside the deployment. */
    | 'TEI_ENDPOINT_OUTSIDE_PERIMETER'
    /** EMBEDDING_PROVIDER is neither `stub` nor `tei`. */
    | 'EMBEDDING_PROVIDER_UNKNOWN';

export type EmbeddingConfig =
    | { readonly ok: true; readonly provider: 'stub' }
    | { readonly ok: true; readonly provider: 'tei'; readonly tei: TeiRoute }
    | { readonly ok: false; readonly reason: EmbeddingConfigRefusal; readonly detail?: string };

export type EmbeddingEnv = Readonly<Record<string, string | undefined>>;

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

function parseDimensions(raw: string | undefined): number | null {
    if (!raw || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= MAX_EMBEDDING_DIMENSIONS ? n : null;
}

function teiRoute(e: EmbeddingEnv): EmbeddingConfig {
    const baseUrl = e.EMBEDDING_TEI_BASE_URL;
    if (!present(baseUrl)) return { ok: false, reason: 'TEI_URL_NOT_CONFIGURED' };
    const model = e.EMBEDDING_TEI_MODEL;
    if (!present(model)) return { ok: false, reason: 'TEI_MODEL_NOT_CONFIGURED' };
    const dimensions = parseDimensions(e.EMBEDDING_TEI_DIMENSIONS);
    if (dimensions === null) return { ok: false, reason: 'TEI_DIMENSIONS_NOT_CONFIGURED' };
    const perimeter = checkPerimeterUrl(baseUrl);
    if (!perimeter.ok) return { ok: false, reason: 'TEI_ENDPOINT_OUTSIDE_PERIMETER', detail: perimeter.reason };
    const queryPrefix = e.EMBEDDING_TEI_QUERY_PREFIX ?? '';
    const passagePrefix = e.EMBEDDING_TEI_PASSAGE_PREFIX ?? '';
    let revision: string;
    try {
        revision = embeddingRevisionOf({ model, dimensions, queryPrefix, passagePrefix });
    } catch (err) {
        if (err instanceof InvalidEmbeddingRevisionError) return { ok: false, reason: 'TEI_MODEL_INVALID' };
        throw err;
    }
    return { ok: true, provider: 'tei', tei: { baseUrl, model, dimensions, queryPrefix, passagePrefix, revision } };
}

/** The provider this environment configures, or why it configures none. */
export function resolveEmbeddingConfig(e: EmbeddingEnv): EmbeddingConfig {
    const production = e.NODE_ENV === 'production';
    const chosen = present(e.EMBEDDING_PROVIDER) ? e.EMBEDDING_PROVIDER : undefined;
    if (chosen === undefined) return production ? { ok: false, reason: 'EMBEDDING_NOT_CONFIGURED' } : { ok: true, provider: 'stub' };
    if (chosen === 'stub') return production ? { ok: false, reason: 'STUB_IN_PRODUCTION' } : { ok: true, provider: 'stub' };
    if (chosen === 'tei') return teiRoute(e);
    return { ok: false, reason: 'EMBEDDING_PROVIDER_UNKNOWN' };
}

const PROBLEM: Record<Exclude<EmbeddingConfigRefusal, 'EMBEDDING_NOT_CONFIGURED'>, string> = {
    STUB_IN_PRODUCTION:
        'EMBEDDING_PROVIDER=stub is for development and test: its vectors carry no meaning. Set EMBEDDING_PROVIDER=tei, or unset it.',
    TEI_URL_NOT_CONFIGURED: 'EMBEDDING_TEI_BASE_URL is required when EMBEDDING_PROVIDER=tei.',
    TEI_MODEL_NOT_CONFIGURED: "EMBEDDING_TEI_MODEL is required when EMBEDDING_PROVIDER=tei (TEI's --model-id, exactly).",
    TEI_DIMENSIONS_NOT_CONFIGURED: `EMBEDDING_TEI_DIMENSIONS is required when EMBEDDING_PROVIDER=tei: an integer from 1 to ${MAX_EMBEDDING_DIMENSIONS}.`,
    TEI_MODEL_INVALID: 'EMBEDDING_TEI_MODEL holds characters an embedding revision cannot name.',
    TEI_ENDPOINT_OUTSIDE_PERIMETER:
        'EMBEDDING_TEI_BASE_URL must name a service inside the deployment (loopback, RFC 1918 or unique-local; no credentials in the URL).',
    EMBEDDING_PROVIDER_UNKNOWN: 'EMBEDDING_PROVIDER must be tei (or unset).',
};

/**
 * What a PRODUCTION process refuses to start with. An unset provider is not a
 * problem yet: nothing in the product embeds until 2.1 (question dedupe),
 * which makes `tei` required here when it lands.
 */
export function embeddingConfigProblems(e: EmbeddingEnv): string[] {
    const config = resolveEmbeddingConfig(e);
    if (config.ok || config.reason === 'EMBEDDING_NOT_CONFIGURED') return [];
    return [PROBLEM[config.reason]];
}
