import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The interview API against the production build (Phase 2.2). The model
 * layer is not wired yet (2.1), so the production server must REFUSE to
 * generate questions — 503 MODEL_NOT_WIRED, nothing written — rather than
 * fake any; a scope with nothing to ask about is refused before the model is
 * needed, and the book's interview list reads empty. (No UI: that is 2.4.)
 */

test('a production server refuses to generate questions until the model is wired, and writes nothing', async ({ page }) => {
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const bookId = (await (await api.post(base, { data: { title: 'The Tuner’s Year' } })).json()).book.id as string;
    const elementId = (await (await api.post(`${base}/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Aurel Pask' } })).json()).element.id as string;

    const started = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } });
    expect(started.status()).toBe(503);
    expect((await started.json()).error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { reason: 'MODEL_NOT_WIRED' } });

    const empty = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'KIND', kind: 'FACTION' } });
    expect(empty.status()).toBe(400);
    expect((await empty.json()).error.details).toMatchObject({ reason: 'SCOPE_EMPTY' });

    const list = await api.get(`${base}/${bookId}/interviews`);
    expect(list.status()).toBe(200);
    expect(await list.json()).toEqual({ sessions: [], truncated: false });
});
