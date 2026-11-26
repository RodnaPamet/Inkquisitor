import { expect, test } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * The fact layer end to end (Phase 4.1, D27), on the production build with the
 * STUBBED MODEL (D13) and the worker: the author saves a bible change; with no
 * further act of theirs the worker's minutely dispatcher queues its extraction,
 * the stub states the entry's facts, they count at once, and an interview
 * started afterwards does not ask the field the change answers. The Facts page
 * still opens, and has nothing to decide (no contradiction was raised).
 */
test.use({ baseURL: STUB_BASE_URL });

test('save a bible change → the fact is extracted in the background → the interview does not ask the field it answers', async ({ page }) => {
    test.setTimeout(240_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Lock Keeper' } })).json()) as { book: { id: string } }).book.id;
    const element = (await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'The lock keeper’s daughter' }] } })).json()) as {
        element: { id: string; versionNumber: number };
    };
    const elementId = element.element.id;
    const asks = async () => {
        const started = await api.post(`/api/w/${slug}/books/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } });
        expect(started.status()).toBe(201);
        const view = (await started.json()) as { interview: { round: { questions: Array<{ targetsFieldKeys: string[] }> } | null } };
        return (view.interview.round?.questions ?? []).flatMap((q) => q.targetsFieldKeys);
    };
    // Before the change: the want is asked.
    expect(await asks()).toContain('want');

    // The author saves a summary that states the want — and does nothing else.
    const saved = await api.patch(`/api/w/${slug}/books/${bookId}/elements/${elementId}`, { data: { summary: 'Wren wants to cross the river before the spring floods.', baseVersion: element.element.versionNumber } });
    expect(saved.status()).toBe(200);

    // The worker extracts it (the version settles, the minutely dispatcher queues it): the want is no longer asked.
    await expect.poll(async () => (await asks()).includes('want'), { timeout: 200_000, intervals: [5_000] }).toBe(false);

    // The Facts page opens; nothing contradicts anything, so there is nothing to decide.
    await page.goto(`/w/${slug}/books/${bookId}/facts`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('#fact-proposals')).toHaveCount(0);
});
