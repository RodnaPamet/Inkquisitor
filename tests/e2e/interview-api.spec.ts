import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The interview API against the production build (Phase 2.2; since 2.3 under
 * decision D11). Production mounts an interview pack only on a REAL MODEL's
 * evaluation record, and none is committed yet (the `Evals` workflow makes
 * them), so a production server refuses every interview, loudly: 503
 * PACKS_NOT_MOUNTABLE naming each pack and its reason, with nothing written —
 * never a session run on an unevaluated pack. The packs endpoint says the same
 * per pack; the dial defaults work regardless. A scope with nothing to ask
 * about is refused before the packs are asked. (No UI: that is 2.4.)
 */

test('a production server without real-model pack records refuses every interview, named, and writes nothing', async ({ page }) => {
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const bookId = (await (await api.post(base, { data: { title: 'The Tuner’s Year' } })).json()).book.id as string;
    const elementId = (await (await api.post(`${base}/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Aurel Pask' } })).json()).element.id as string;

    const started = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3, personaKeys: ['socratic'] } });
    expect(started.status()).toBe(503);
    expect((await started.json()).error.details).toEqual({
        reason: 'PACKS_NOT_MOUNTABLE',
        packs: [
            { name: 'craft-character', reason: 'STRUCTURAL_RECORD_REFUSED' },
            { name: 'persona-socratic', reason: 'STRUCTURAL_RECORD_REFUSED' },
        ],
    });

    const empty = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'KIND', kind: 'FACTION' } });
    expect(empty.status()).toBe(400);
    expect((await empty.json()).error.details).toMatchObject({ reason: 'SCOPE_EMPTY' });

    const list = await api.get(`${base}/${bookId}/interviews`);
    expect(list.status()).toBe(200);
    expect((await list.json()).sessions).toHaveLength(0);

    const packs = await api.get(`/api/w/${slug}/interview-packs`);
    expect(packs.status()).toBe(200);
    const body = await packs.json();
    // Six personas, the book-level panel's three (Phase 4.3), sixteen craft packs and the relations pack (Phase 3.3).
    expect(body).toMatchObject({ recordMode: 'model', mountable: 0, total: 26 });
    expect(body.personas).toHaveLength(9);
    expect(body.relations).toHaveLength(1);
    expect([...body.personas, ...body.craft, ...body.relations].every((p: { refusal: { reason: string } }) => p.refusal.reason === 'STRUCTURAL_RECORD_REFUSED')).toBe(true);
});

test('the dial defaults: a workspace layer and a book layer, resolved book over workspace', async ({ page }) => {
    const slug = await signUp(page);
    const api = page.request;
    const bookId = (await (await api.post(`/api/w/${slug}/books`, { data: { title: 'Defaults' } })).json()).book.id as string;

    const ws = await api.put(`/api/w/${slug}/interview-defaults`, { data: { depth: 4, personaKeys: ['gentle-mentor', 'target-reader'] } });
    expect(ws.status()).toBe(200);
    const book = await api.put(`/api/w/${slug}/books/${bookId}/interview-defaults`, { data: { depth: 2, preferChoice: true } });
    expect(book.status()).toBe(200);
    const read = await (await api.get(`/api/w/${slug}/books/${bookId}/interview-defaults`)).json();
    expect(read.defaults).toMatchObject({
        effective: { depth: 2, detail: 3, personaKeys: ['gentle-mentor', 'target-reader'], offerRecommended: true, preferChoice: true },
        sources: { depth: 'book', detail: 'code', personaKeys: 'workspace', offerRecommended: 'code', preferChoice: 'book' },
        effects: { roundBudget: 3, generationCallsPerRound: 2 },
    });
    const bad = await api.put(`/api/w/${slug}/interview-defaults`, { data: { personaKeys: ['socratic', 'socratic'] } });
    expect(bad.status()).toBe(400);
});
