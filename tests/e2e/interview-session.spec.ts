import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * A whole interview in the browser (Phase 2.4), against the production build
 * with the STUBBED MODEL (`AI_MODEL_STUB=1`, the second E2E server,
 * tests/e2e/stub-server.ts): every model call goes the real way — the client,
 * the messages-only middleware, callStructured, the guard, the ledger — and is
 * answered in-process, so nothing leaves the machine.
 *
 * Three rounds on one character at depth 3: Enrich opens the setup sheet, the
 * first round streams in, every kind of answer is given (picks by number key,
 * text with Ctrl+Enter, a suggestion taken with one click), one question is
 * asked differently, the side panel fills as answers arrive, each round is
 * finished and the next streams in, and after the third the interview
 * completes, saying why. It is listed with its status, and a reload resumes it.
 */
test.use({ baseURL: STUB_BASE_URL });

async function answerCard(card: Locator, page: Page) {
    const kind = await card.getAttribute('data-kind');
    if (kind === 'OPEN' || kind === 'SCENARIO') {
        await card.getByTestId('answer-text').fill('It comes from the river, and it costs her.');
        await page.keyboard.press('Control+Enter');
    } else {
        // Keyboard first: focus inside the card, then a number key picks (and saves).
        await card.getByTestId('answer-option').first().focus();
        await page.keyboard.press('2');
    }
    await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
}

async function roundCards(page: Page, round: number): Promise<Locator> {
    const list = page.getByRole('main').locator(`[data-testid="round-questions"][data-round="${round}"]`);
    await expect(list).toBeVisible({ timeout: 20_000 });
    return list.getByTestId('question-card');
}

test('three rounds against the stubbed model: stream, answer by kind, ask differently, finish, complete', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book.id;
    const elementId = ((await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Mara' } })).json()) as { element: { id: string } }).element.id;
    const main = page.getByRole('main');

    // Enrich → the setup sheet, with a preview of each setting → Start.
    await page.goto(`/w/${slug}/books/${bookId}/elements/${elementId}`);
    await main.locator('#element-enrich').click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByTestId('depth-preview')).toContainText('in up to 4 rounds');
    await sheet.locator('#interview-start').click();

    // The page becomes the session's own as soon as it exists, and round 1 streams in.
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/interviews/(?!new)[^/?]+$`), { timeout: 20_000 });
    const sessionUrl = new URL(page.url()).pathname;

    // ROUND 1: the character's foundations. Take a suggestion where one is offered.
    let cards = await roundCards(page, 1);
    expect(await cards.count()).toBeGreaterThan(0);
    const panel = main.getByTestId('round-fields');
    for (const card of await cards.all()) {
        const accept = card.getByTestId('accept-recommended');
        if (await accept.isVisible()) {
            await accept.click();
            await expect(card).toHaveAttribute('data-status', 'ANSWERED');
        } else await answerCard(card, page);
    }
    await expect(panel.locator('[data-testid="round-field"][data-state="pending"]')).toHaveCount(await cards.count());
    await main.locator('#round-finish').click();

    // ROUND 2: ask the first question differently, then answer everything.
    cards = await roundCards(page, 2);
    const first = cards.first();
    const before = await first.getAttribute('data-question-id');
    const text = await first.locator('p.text-base, blockquote').first().textContent();
    await first.getByTestId('rephrase').click();
    await expect(cards.first()).not.toHaveAttribute('data-question-id', before ?? '', { timeout: 10_000 });
    await expect(cards.first()).toContainText('Asked differently');
    expect(await cards.first().locator('p.text-base, blockquote').first().textContent()).not.toBe(text);
    for (const card of await cards.all()) await answerCard(card, page);
    await main.locator('#round-finish').click();

    // ROUND 3, then the interview completes: nothing else is in reach at depth 3.
    cards = await roundCards(page, 3);
    for (const card of await cards.all()) await answerCard(card, page);
    await expect(main.getByTestId('session-progress')).toContainText(/\d+ of \d+ answered/);
    await main.locator('#round-finish').click();
    await expect(main.getByTestId('session-status')).toHaveText('Completed', { timeout: 20_000 });
    await expect(main.getByTestId('stop-reason')).toHaveAttribute('data-reason', /FRONTIER_EMPTY|NOTHING_AT_DEPTH/);

    // Listed, with its status and reason; and a reload resumes it as stored.
    await page.goto(`/w/${slug}/books/${bookId}/interviews`);
    const row = main.getByTestId('interviews-table');
    await expect(row).toContainText('Mara');
    await expect(row).toContainText('Completed');
    await page.goto(sessionUrl);
    await expect(main.getByTestId('session-status')).toHaveText('Completed');
    await expect(main.locator('[data-testid="round-questions"][data-round="3"]')).toBeVisible();
});

test('Grill me on a kind; the author can stop at any time and keep what was answered', async ({ page }) => {
    test.setTimeout(120_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Tuner’s Year' } })).json()) as { book: { id: string } }).book.id;
    await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'SETTING', name: 'The Drowned Quarter' } });
    const main = page.getByRole('main');

    // "Grill me" on a kind's card.
    await page.goto(`/w/${slug}/books/${bookId}`);
    await main.locator('[data-kind="SETTING"]').getByRole('button', { name: /Grill me on/ }).click();
    await page.getByRole('dialog').locator('#interview-start').click();
    const cards = await roundCards(page, 1);
    await answerCard(cards.first(), page);

    await main.locator('#interview-stop').click();
    await page.locator('#interview-stop-confirm').click();
    await expect(main.getByTestId('stop-reason')).toHaveAttribute('data-reason', 'AUTHOR_STOPPED');
    await expect(main.getByTestId('session-status')).toHaveText('Stopped');
    await expect(main.getByTestId('question-card').first()).toHaveAttribute('data-status', 'ANSWERED');
    await expect(main.locator('#round-next')).toHaveCount(0);
});
