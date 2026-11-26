import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { SETUP_OPTIONS_TIMEOUT_MS, STUB_BASE_URL } from './stub-server';

/**
 * Book-level interrogation end to end (Phase 4.3, D29), on the production build
 * with the STUBBED MODEL (D13) and the worker:
 *
 *   - the stress test: the Interrogate page shows the "at most" first, the
 *     author confirms it, the worker's job finds weak points (each a question
 *     citing the book), and "Start a session from these" opens an interview
 *     scoped to what they cite, whose first question is answered;
 *   - the persona panel: the Panel preset starts a book interview with the
 *     three panel personas, and the session groups its questions by who asked.
 */
test.use({ baseURL: STUB_BASE_URL });

type Created = { element: { id: string } };

async function seedBook(page: Page, title: string): Promise<{ slug: string; bookId: string }> {
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const bookId = ((await (await api.post(base, { data: { title } })).json()) as { book: { id: string } }).book.id;
    for (const [name, summary] of [
        ['Ilse', 'Ilse keeps the lighthouse and burns its logbook.'],
        ['Corvin', 'Corvin arrives on the ferry and asks about the keeper.'],
    ]) {
        const res = await api.post(`${base}/${bookId}/elements`, { data: { kind: 'CHARACTER', name, summary } });
        expect(res.ok()).toBe(true);
        expect(((await res.json()) as Created).element.id).toBeTruthy();
    }
    return { slug, bookId };
}

async function answerFirst(card: Locator, page: Page) {
    const kind = await card.getAttribute('data-kind');
    const accept = card.getByTestId('accept-recommended');
    if (await accept.isVisible()) await accept.click();
    else if (kind === 'OPEN' || kind === 'SCENARIO') {
        await card.getByTestId('answer-text').fill('She burns it so nobody learns what she saw.');
        await page.keyboard.press('Control+Enter');
    } else {
        await card.getByTestId('answer-option').first().focus();
        await page.keyboard.press('1');
    }
    await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
}

test('a stress test: confirm the cost, read the weak points, start a session from them and answer', async ({ page }) => {
    test.setTimeout(180_000);
    const { slug, bookId } = await seedBook(page, 'The Lamp Room');
    const main = page.getByRole('main');

    await page.goto(`/w/${slug}/books/${bookId}`);
    await main.locator('#book-interrogate').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/interrogate$`));

    // The cost is shown first; nothing runs until the author confirms it.
    await expect(main.getByTestId('stress-estimate')).toBeVisible();
    await main.locator('#stress-start').click();
    await page.getByRole('dialog').locator('[data-modal-confirm]').click();

    // The worker's job runs; the page polls the live test and shows its weak points.
    const test1 = main.getByTestId('stress-test').first();
    await expect(test1).toHaveAttribute('data-status', 'DONE', { timeout: 120_000 });
    const weak = test1.getByTestId('weak-point');
    await expect(weak).toHaveCount(2);
    await expect(weak.first()).toContainText('?');
    await expect(weak.first().getByTestId('weak-point-cites')).toContainText(/Ilse|Corvin/);

    // A session from the set: scoped to what the weak points cite, starting at once.
    await test1.getByTestId('stress-start-session').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/interviews/(?!new)[^/?]+$`), { timeout: 30_000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop()!;
    const opened = (await (await page.request.get(`/api/w/${slug}/books/${bookId}/interviews/${sessionId}`)).json()) as {
        interview: { session: { scope: string; stressTestId: string | null } };
    };
    expect(opened.interview.session.scope).toBe('SELECTION');
    expect(opened.interview.session.stressTestId).toBeTruthy();
    const card = main.getByTestId('question-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await answerFirst(card, page);
});

test('a persona panel: the Panel preset questions the book, grouped by who asked', async ({ page }) => {
    test.setTimeout(180_000);
    const { slug, bookId } = await seedBook(page, 'The Ferry Ledger');
    const main = page.getByRole('main');

    await page.goto(`/w/${slug}/books/${bookId}/interrogate`);
    await main.locator('#interrogate-panel').click();
    const sheet = page.getByRole('dialog');
    const preset = sheet.getByTestId('panel-preset');
    await expect(preset.getByRole('checkbox')).toBeEnabled({ timeout: SETUP_OPTIONS_TIMEOUT_MS });
    await preset.getByRole('checkbox').click();
    await expect(preset.getByRole('checkbox')).toBeChecked();
    await sheet.locator('#interview-start').click();

    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/interviews/(?!new)[^/?]+$`), { timeout: 30_000 });
    const groups = main.getByTestId('persona-group');
    await expect(groups.first()).toBeVisible({ timeout: 30_000 });
    expect(await groups.count()).toBeGreaterThanOrEqual(2);
    const personas = await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-persona')));
    for (const p of personas) expect(p).toMatch(/^panel-(target-reader|ruthless-editor|genre-specialist)$/);
    await expect(groups.first()).toContainText('Asked by');
    await answerFirst(groups.first().getByTestId('question-card').first(), page);
});
