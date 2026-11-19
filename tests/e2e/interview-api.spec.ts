import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The interview API against the production build (Phase 2.2, wired to 2.1).
 * The E2E server holds no model key — no test reaches a provider — so it runs
 * with AI switched off (`AI_DISABLED=1`, playwright.config.ts): production
 * refuses to start with neither (production-refusal.spec.ts names the missing
 * key). A session that would need the model is created and PAUSED with the
 * named reason KILL_SWITCH, with no round and no question: nothing is sent and
 * nothing faked. A scope with nothing to ask about is refused before the model
 * is needed. (No UI: that is 2.4.)
 */

test('a production server with AI switched off pauses the interview, named, and fakes no question', async ({ page }) => {
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const bookId = (await (await api.post(base, { data: { title: 'The Tuner’s Year' } })).json()).book.id as string;
    const elementId = (await (await api.post(`${base}/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Aurel Pask' } })).json()).element.id as string;

    const started = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } });
    expect(started.status()).toBe(201);
    const view = (await started.json()).interview;
    expect(view.session).toMatchObject({ status: 'PAUSED', stopReason: 'KILL_SWITCH' });
    expect(view.round).toBeNull();

    // Resuming while the switch is on pauses it again, still asking nothing.
    const again = await api.post(`${base}/${bookId}/interviews/${view.session.id}/rounds`, { data: {} });
    expect(again.status()).toBeLessThan(300);
    expect((await again.json()).interview).toMatchObject({ session: { status: 'PAUSED', stopReason: 'KILL_SWITCH' }, round: null });

    const empty = await api.post(`${base}/${bookId}/interviews`, { data: { scope: 'KIND', kind: 'FACTION' } });
    expect(empty.status()).toBe(400);
    expect((await empty.json()).error.details).toMatchObject({ reason: 'SCOPE_EMPTY' });

    const list = await api.get(`${base}/${bookId}/interviews`);
    expect(list.status()).toBe(200);
    const listed = await list.json();
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ id: view.session.id, status: 'PAUSED', stopReason: 'KILL_SWITCH' });
});
