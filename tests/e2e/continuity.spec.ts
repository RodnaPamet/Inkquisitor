import { expect, test } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * Continuity end to end (Phase 4.2, D28), on the production build with the
 * STUBBED MODEL (D13) and the worker:
 *
 *   - a contradiction: the author saves an age, the worker's fact layer states
 *     it; the author saves a different age, and the next extraction proposes
 *     the two as a contradiction (by rule), which the Continuity page shows
 *     with both sources and the author resolves ("both true", explained);
 *   - propagation debt: an interview about Marrow names a stranger, whose new
 *     entry, accepted, cites that answer; Marrow changes, the stranger's entry
 *     is flagged "may be stale", and "grill me on what changed" opens an
 *     interview scoped to it.
 */
test.use({ baseURL: STUB_BASE_URL });

type ContinuityView = { liveFacts: number; contradictions: { items: Array<{ id: string }> }; stale: { items: Array<{ id: string; elementName: string | null; upstreamName: string | null }> } };

test('a contradiction appears on the Continuity page with both sources and is resolved', async ({ page }) => {
    test.setTimeout(360_000);
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const bookId = ((await (await api.post(base, { data: { title: 'The Weir' } })).json()) as { book: { id: string } }).book.id;
    const view = async () => (await (await api.get(`${base}/${bookId}/continuity`)).json()) as ContinuityView;
    const element = ((await (await api.post(`${base}/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Wren', summary: 'Wren is 12 years old.' } })).json()) as { element: { id: string; versionNumber: number } }).element;

    // The worker states the first age (the version settles, the minutely dispatcher queues it).
    await expect.poll(async () => (await view()).liveFacts, { timeout: 150_000, intervals: [5_000] }).toBeGreaterThan(0);
    const saved = await api.patch(`${base}/${bookId}/elements/${element.id}`, { data: { summary: 'Wren is 14 years old.', baseVersion: element.versionNumber } });
    expect(saved.status()).toBe(200);
    // The second extraction proposes the pair; nothing is set aside until the author decides.
    await expect.poll(async () => (await view()).contradictions.items.length, { timeout: 150_000, intervals: [5_000] }).toBe(1);

    const main = page.getByRole('main');
    await page.goto(`/w/${slug}/books/${bookId}/continuity`);
    const card = main.getByTestId('continuity-contradiction');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('continuity-fact')).toHaveCount(2);
    await expect(card).toContainText('Wren is 12 years old.');
    await expect(card).toContainText('Wren is 14 years old.');

    await card.getByTestId('contradiction-both-true').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#contradiction-explanation').fill('Wren lies about her age to the lock keepers.');
    await dialog.locator('#contradiction-explanation-submit').click();
    await expect(page.getByText('Decided.')).toBeVisible();
    await expect(main.getByTestId('continuity-contradiction')).toHaveCount(0);
    await expect.poll(async () => (await view()).contradictions.items.length, { timeout: 10_000 }).toBe(0);
});

test('an upstream change flags the entry that cited it; "grill me on what changed" opens an interview scoped to it', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page);
    const api = page.request;
    const books = `/api/w/${slug}/books`;
    const bookId = ((await (await api.post(books, { data: { title: 'The Mill' } })).json()) as { book: { id: string } }).book.id;
    const marrow = ((await (await api.post(`${books}/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Marrow', fields: [{ key: 'role', value: 'The miller' }] } })).json()) as { element: { id: string; versionNumber: number } })
        .element;

    // An interview about Marrow at detail 5 (written answers): each names a stranger, whom reconcile proposes as a new character citing it.
    const base = `${books}/${bookId}/interviews`;
    const started = (await (await api.post(base, { data: { scope: 'ELEMENT', elementId: marrow.id, depth: 2, detail: 5 } })).json()) as {
        interview: { session: { id: string }; round: { number: number; questions: Array<{ id: string; kind: string; options: string[] | null }> } };
    };
    const { session, round } = started.interview;
    for (const q of round.questions) {
        const data = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'Marrow fears a stranger named Tamsin.' };
        expect((await api.post(`${base}/${session.id}/questions/${q.id}/answer`, { data })).ok()).toBe(true);
    }
    const closed = (await (await api.post(`${base}/${session.id}/rounds/${round.number}/close`, { data: {} })).json()) as { reconcile: { status: string } | null };
    expect(closed.reconcile?.status).toBe('DONE');
    const listed = (await (await api.get(`${base}/${session.id}/proposals`)).json()) as { review: { newElements: Array<{ id: string; name: string; status: string }> } };
    const stranger = listed.review.newElements.find((p) => p.name === 'Tamsin' && p.status === 'PENDING');
    expect(stranger).toBeDefined();
    expect((await api.post(`${base}/${session.id}/proposals/${stranger!.id}/accept`, { data: {} })).ok()).toBe(true);

    // Nothing is stale until Marrow changes; then Tamsin's entry (it cited an answer about Marrow) is.
    const view = async () => (await (await api.get(`${books}/${bookId}/continuity`)).json()) as ContinuityView;
    expect((await view()).stale.items).toEqual([]);
    const current = ((await (await api.get(`${books}/${bookId}/elements/${marrow.id}`)).json()) as { element: { versionNumber: number } }).element.versionNumber;
    expect((await api.patch(`${books}/${bookId}/elements/${marrow.id}`, { data: { summary: 'Marrow sold the mill.', baseVersion: current } })).status()).toBe(200);
    expect((await view()).stale.items.map((f) => [f.elementName, f.upstreamName])).toEqual([['Tamsin', 'Marrow']]);

    const main = page.getByRole('main');
    await page.goto(`/w/${slug}/books/${bookId}/continuity`);
    const row = main.getByTestId('continuity-stale');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Tamsin');
    await row.getByTestId('stale-grill').click();
    // The link carries the whole setup (3.3's SELECTION query, with the flag), so the session starts at once.
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/interviews/(?!new)[^/?]+$`), { timeout: 30_000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop()!;
    const opened = (await (await api.get(`${base}/${sessionId}`)).json()) as { interview: { session: { scope: string } } };
    expect(opened.interview.session.scope).toBe('SELECTION');
    await expect(main.getByTestId('question-card').first()).toBeVisible({ timeout: 30_000 });
});
