import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';
import { escapeRegExp } from '../helpers/escape-regexp';

/**
 * From an interview's answers to an accepted bible change, in the browser
 * (Phase 2.5), on the production build with the STUBBED MODEL (the second E2E
 * server, decision D13): the round is finished on the interview page, its
 * answers are reconciled through the real path — the client, the middleware,
 * callStructured, the guard, the ledger, the product's validation — with the
 * stub answering the reconcile call conservatively (an ADD of each answer's
 * own words into its empty field). The side panel links to the review; there
 * the author accepts one change as proposed, edits another, and the bible
 * holds versions with source INTERVIEW.
 */
test.use({ baseURL: STUB_BASE_URL });

async function answerCard(card: Locator, page: Page) {
    const kind = await card.getAttribute('data-kind');
    if (kind === 'OPEN' || kind === 'SCENARIO') {
        await card.getByTestId('answer-text').fill('She keeps the ledger of every crossing.');
        await page.keyboard.press('Control+Enter');
    } else {
        await card.getByTestId('answer-option').first().focus();
        await page.keyboard.press('1');
    }
    await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
}

test('interview → finish the round → reconciled → review → accept, edit then accept', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book.id;
    const elementId = ((await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'role', value: 'Ferrywoman' }] } })).json()) as {
        element: { id: string };
    }).element.id;
    const main = page.getByRole('main');

    // An interview, started through the API (2.2) and answered on its page (2.4).
    const started = (await (await api.post(`/api/w/${slug}/books/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } })).json()) as {
        interview: { session: { id: string } };
    };
    const sessionId = started.interview.session.id;
    await page.goto(`/w/${slug}/books/${bookId}/interviews/${sessionId}`);
    const cards = main.locator('[data-testid="round-questions"][data-round="1"]').getByTestId('question-card');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    for (const card of await cards.all()) await answerCard(card, page);
    await main.locator('#round-finish').click();
    // The close reconciled the round: the page says how many changes were proposed.
    await expect(main.getByText(/bible changes? (was|were) proposed from this round/)).toBeVisible({ timeout: 30_000 });

    // The side panel's pending enrichment leads to the review.
    await main.locator('#review-proposals').click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${escapeRegExp(sessionId)}/review$`));
    const proposals = main.getByTestId('field-proposal');
    await expect(proposals.first()).toBeVisible({ timeout: 20_000 });
    expect(await proposals.count()).toBeGreaterThan(1);
    await expect(main.getByTestId('reconcile-run').first()).toHaveAttribute('data-outcome', 'OK');

    // Accept the first as proposed.
    const first = proposals.first();
    await expect(first.getByTestId('proposal-sources')).toContainText(/ledger of every crossing|Ferry|settled|shifts|revealed|hidden|open/);
    await first.getByRole('button', { name: /^Accept the change/ }).click();
    await expect(first.getByTestId('proposal-status')).toHaveText('Accepted', { timeout: 10_000 });

    // Edit a text field's proposal before accepting it (the field's own editor).
    const read = async () =>
        ((await (await api.get(`/api/w/${slug}/books/${bookId}/interviews/${sessionId}/proposals`)).json()) as {
            review: { fields: Array<{ id: string; status: string; field: { type: string } }>; newElements: Array<{ status: string }> };
        }).review;
    const target = (await read()).fields.find((f) => f.status === 'PENDING' && f.field.type === 'text');
    expect(target).toBeDefined();
    const card = main.locator(`#proposal-${target!.id}`);
    await card.getByRole('button', { name: 'Edit, then accept' }).click();
    await card.locator('input[data-testid^="field-input-"]').fill('Keeps the ledger of the crossings, by her own account.');
    await card.getByRole('button', { name: 'Accept my version' }).click();
    await expect(card.getByTestId('proposal-status')).toHaveText('Accepted with your edit', { timeout: 10_000 });

    // The bible holds the accepted changes, each an INTERVIEW version.
    const versions = (await (await api.get(`/api/w/${slug}/books/${bookId}/elements/${elementId}/versions`)).json()) as { versions: Array<{ source: string }> };
    expect(versions.versions.filter((v) => v.source === 'INTERVIEW')).toHaveLength(2);

    // The interviews list says what is left to review, and links to it.
    const after = await read();
    const left = [...after.fields, ...after.newElements].filter((p) => p.status === 'PENDING').length;
    await page.goto(`/w/${slug}/books/${bookId}/interviews`);
    await expect(main.getByTestId('interviews-table')).toContainText('Mara');
    if (left > 0) await expect(main.getByTestId('review-link')).toHaveAttribute('href', `/w/${slug}/books/${bookId}/interviews/${sessionId}/review`);
    else await expect(main.getByTestId('review-link')).toHaveCount(0);
});
