/**
 * The deterministic stub, the embedding revision, the keyed content hash and
 * the one reading of the EMBEDDING_* variables
 * (`src/lib/ai/embeddings/{stub-provider,revision,content-hash,config,select}.ts`).
 *
 * The stub half is adapted from inflect-compliance's
 * `tests/unit/ai/embedding-stub-and-revision.test.ts`; the rest is new, for
 * what Inkquisitor changed: the stub is the development default (so its
 * vectors must live in a revision of their own), the content hash is keyed,
 * and production refuses the stub. No test here reaches the network.
 */
import { createHash } from 'node:crypto';
import { embeddingConfigProblems, resolveEmbeddingConfig } from '@/lib/ai/embeddings/config';
import { vectorContentHash } from '@/lib/ai/embeddings/content-hash';
import { EMBEDDING_REVISION_PATTERN, embeddingRevisionOf, InvalidEmbeddingRevisionError } from '@/lib/ai/embeddings/revision';
import { getEmbeddingProvider } from '@/lib/ai/embeddings/select';
import { STUB_DEFAULT_DIMENSIONS, StubEmbeddingProvider, stubVector } from '@/lib/ai/embeddings/stub-provider';
import { _resetKeyCache } from '@/lib/security/encryption';

const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

describe('the stub embedding is deterministic and carries a lexical signal', () => {
    it('the same text yields the same unit vector every time, whatever the input type', async () => {
        const p = new StubEmbeddingProvider(32);
        const first = await p.embed(['The lighthouse keeper lies about the storm'], { inputType: 'passage' });
        const again = await p.embed(['The lighthouse keeper lies about the storm'], { inputType: 'query' });
        expect(first.ok && again.ok && first.vectors[0]).toEqual(again.ok && again.vectors[0]);
        expect(first.ok && first.vectors[0].length).toBe(32);
        expect(first.ok && cosine(first.vectors[0], first.vectors[0])).toBeCloseTo(1, 10);
    });

    it('texts sharing words are closer than texts sharing none', () => {
        const q = stubVector('what does Mara want most', 256);
        const near = stubVector('Mara wants the ship back most of all', 256);
        const far = stubVector('the guild meets at dawn in the salt hall', 256);
        expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
    });

    it('a text with no words is the zero vector, not NaN (and the store refuses it)', () => {
        expect(stubVector('  ...  ', 8)).toEqual(new Array(8).fill(0));
    });

    it('the stub honours the same bounds as the real provider', async () => {
        const p = new StubEmbeddingProvider();
        expect(await p.embed([], { inputType: 'query' })).toEqual({ ok: false, reason: 'EMPTY_INPUT' });
        expect(await p.embed(Array.from({ length: 65 }, () => 'x'), { inputType: 'query' })).toEqual({
            ok: false,
            reason: 'BATCH_TOO_LARGE',
        });
    });

    it('files its vectors under a revision of its own, so no real model is ever compared with it', async () => {
        const p = new StubEmbeddingProvider();
        expect(p.providerId).toBe('stub');
        expect(p.revision).toMatch(/^stub-feature-hash@1:d64:p[0-9a-f]{8}$/);
        const out = await p.embed(['a'], { inputType: 'passage' });
        expect(out.ok && out.revision).toBe(p.revision);
        const real = embeddingRevisionOf({ model: 'BAAI/bge-small-en-v1.5', dimensions: STUB_DEFAULT_DIMENSIONS, queryPrefix: '', passagePrefix: '' });
        expect(real).not.toBe(p.revision);
    });
});

describe('the embedding revision names the vector space', () => {
    const base = { model: 'BAAI/bge-small-en-v1.5', dimensions: 384, queryPrefix: '', passagePrefix: '' };

    it('is stable, and matches the store pattern', () => {
        expect(embeddingRevisionOf(base)).toBe(embeddingRevisionOf({ ...base }));
        expect(EMBEDDING_REVISION_PATTERN.test(embeddingRevisionOf(base))).toBe(true);
    });

    it.each([
        ['the model', { model: 'BAAI/bge-base-en-v1.5' }],
        ['the dimension count', { dimensions: 768 }],
        ['the query prefix', { queryPrefix: 'query: ' }],
        ['the passage prefix', { passagePrefix: 'passage: ' }],
    ])('moves when %s moves', (_label, change) => {
        expect(embeddingRevisionOf({ ...base, ...change })).not.toBe(embeddingRevisionOf(base));
    });

    it('cannot be forged by moving text between the two prefixes', () => {
        expect(embeddingRevisionOf({ ...base, queryPrefix: 'ab', passagePrefix: '' })).not.toBe(
            embeddingRevisionOf({ ...base, queryPrefix: 'a', passagePrefix: 'b' }),
        );
    });

    it.each([
        ['a padded model', { model: ' m ' }, 'model'],
        ['an empty model', { model: '' }, 'model'],
        ['a model with a space', { model: 'my model' }, 'revision'],
        ['a fractional count', { dimensions: 1.5 }, 'dimensions'],
        ['a zero count', { dimensions: 0 }, 'dimensions'],
    ])('refuses %s', (_label, change, field) => {
        expect(() => embeddingRevisionOf({ ...base, ...change })).toThrow(new InvalidEmbeddingRevisionError(field as 'model').message);
    });
});

describe('the content hash is keyed, so a short text is not recovered by hashing guesses', () => {
    afterEach(() => {
        delete process.env.DATA_ENCRYPTION_KEY;
        _resetKeyCache();
    });

    it('is 64 hex characters, deterministic, and NOT the plain SHA-256 of the text', () => {
        const h = vectorContentHash('ws-1', 'yes');
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(vectorContentHash('ws-1', 'yes')).toBe(h);
        expect(h).not.toBe(createHash('sha256').update('yes').digest('hex'));
        expect(vectorContentHash('ws-1', 'no')).not.toBe(h);
    });

    it('normalises Unicode first: two spellings of one string are one hash', () => {
        expect(vectorContentHash('ws-1', 'café')).toBe(vectorContentHash('ws-1', 'café'));
    });

    it('is keyed per workspace: equal text in two workspaces files different hashes (issue #32 item 2)', () => {
        expect(vectorContentHash('ws-1', 'yes')).not.toBe(vectorContentHash('ws-2', 'yes'));
        expect(vectorContentHash('ws-2', 'yes')).toBe(vectorContentHash('ws-2', 'yes'));
        expect(() => vectorContentHash('', 'yes')).toThrow(/workspace id/);
    });

    it('depends on the deployment key', () => {
        const before = vectorContentHash('ws-1', 'yes');
        process.env.DATA_ENCRYPTION_KEY = 'another-deployment-key-'.repeat(3);
        _resetKeyCache();
        expect(vectorContentHash('ws-1', 'yes')).not.toBe(before);
    });
});

describe('resolveEmbeddingConfig — one reading of the EMBEDDING_* variables', () => {
    const TEI = {
        EMBEDDING_PROVIDER: 'tei',
        EMBEDDING_TEI_BASE_URL: 'http://tei:80',
        EMBEDDING_TEI_MODEL: 'BAAI/bge-small-en-v1.5',
        EMBEDDING_TEI_DIMENSIONS: '384',
    };

    it('development and test default to the stub; production defaults to nothing', () => {
        expect(resolveEmbeddingConfig({ NODE_ENV: 'development' })).toEqual({ ok: true, provider: 'stub' });
        expect(resolveEmbeddingConfig({ NODE_ENV: 'test', EMBEDDING_PROVIDER: '' })).toEqual({ ok: true, provider: 'stub' });
        expect(resolveEmbeddingConfig({ NODE_ENV: 'production' })).toEqual({ ok: false, reason: 'EMBEDDING_NOT_CONFIGURED' });
    });

    it('production refuses the stub, by name', () => {
        expect(resolveEmbeddingConfig({ NODE_ENV: 'production', EMBEDDING_PROVIDER: 'stub' })).toEqual({ ok: false, reason: 'STUB_IN_PRODUCTION' });
        expect(embeddingConfigProblems({ NODE_ENV: 'production', EMBEDDING_PROVIDER: 'stub' })).toHaveLength(1);
    });

    it('a whole TEI route carries its revision', () => {
        const config = resolveEmbeddingConfig({ NODE_ENV: 'production', ...TEI, EMBEDDING_TEI_QUERY_PREFIX: 'query: ' });
        expect(config).toEqual({
            ok: true,
            provider: 'tei',
            tei: {
                baseUrl: 'http://tei:80',
                model: 'BAAI/bge-small-en-v1.5',
                dimensions: 384,
                queryPrefix: 'query: ',
                passagePrefix: '',
                revision: embeddingRevisionOf({ model: 'BAAI/bge-small-en-v1.5', dimensions: 384, queryPrefix: 'query: ', passagePrefix: '' }),
            },
        });
    });

    it.each([
        ['no URL', { EMBEDDING_TEI_BASE_URL: undefined }, 'TEI_URL_NOT_CONFIGURED'],
        ['no model', { EMBEDDING_TEI_MODEL: ' ' }, 'TEI_MODEL_NOT_CONFIGURED'],
        ['no dimension count', { EMBEDDING_TEI_DIMENSIONS: undefined }, 'TEI_DIMENSIONS_NOT_CONFIGURED'],
        ['a dimension count past the store bound', { EMBEDDING_TEI_DIMENSIONS: '4097' }, 'TEI_DIMENSIONS_NOT_CONFIGURED'],
        ['a model no revision can name', { EMBEDDING_TEI_MODEL: 'my model' }, 'TEI_MODEL_INVALID'],
        ['a public address', { EMBEDDING_TEI_BASE_URL: 'https://93.184.216.34' }, 'TEI_ENDPOINT_OUTSIDE_PERIMETER'],
        ['the metadata host', { EMBEDDING_TEI_BASE_URL: 'http://169.254.169.254' }, 'TEI_ENDPOINT_OUTSIDE_PERIMETER'],
        ['credentials in the URL', { EMBEDDING_TEI_BASE_URL: 'http://user:pw@tei:80' }, 'TEI_ENDPOINT_OUTSIDE_PERIMETER'],
        ['an unknown provider', { EMBEDDING_PROVIDER: 'openai' }, 'EMBEDDING_PROVIDER_UNKNOWN'],
    ])('refuses %s', (_label, change, reason) => {
        const config = resolveEmbeddingConfig({ NODE_ENV: 'production', ...TEI, ...change });
        expect(config).toMatchObject({ ok: false, reason });
        expect(embeddingConfigProblems({ NODE_ENV: 'production', ...TEI, ...change })).toHaveLength(1);
    });
});

describe('getEmbeddingProvider — the factory reads env, and a refusal constructs nothing', () => {
    const saved = { ...process.env };
    afterEach(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    });

    it('in test, with nothing configured, it is the stub', () => {
        delete process.env.EMBEDDING_PROVIDER;
        const choice = getEmbeddingProvider();
        expect(choice.ok && choice.provider).toBeInstanceOf(StubEmbeddingProvider);
    });

    it('a TEI route outside the deployment is a refusal, not a provider', () => {
        Object.assign(process.env, {
            EMBEDDING_PROVIDER: 'tei',
            EMBEDDING_TEI_BASE_URL: 'https://93.184.216.34',
            EMBEDDING_TEI_MODEL: 'm',
            EMBEDDING_TEI_DIMENSIONS: '8',
        });
        expect(getEmbeddingProvider()).toMatchObject({ ok: false, reason: 'TEI_ENDPOINT_OUTSIDE_PERIMETER' });
    });

    it('a whole TEI route is a TEI provider carrying the configured space', () => {
        Object.assign(process.env, {
            EMBEDDING_PROVIDER: 'tei',
            EMBEDDING_TEI_BASE_URL: 'http://tei:80',
            EMBEDDING_TEI_MODEL: 'm',
            EMBEDDING_TEI_DIMENSIONS: '8',
        });
        const choice = getEmbeddingProvider();
        expect(choice.ok && { id: choice.provider.providerId, model: choice.provider.model, d: choice.provider.dimensions }).toEqual({
            id: 'tei',
            model: 'm',
            d: 8,
        });
    });
});
