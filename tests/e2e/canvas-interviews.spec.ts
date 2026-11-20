import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * Interviews from the canvas (Phase 3.3, D24) in a real browser, against the
 * production build with the STUBBED MODEL (the second E2E server, D13):
 *
 *   - on the relationship map, two cards selected and "Grill this": the
 *     interview asks about both; once its round is finished, the relation the
 *     stub proposes between them is a GHOST edge on the map and an entry in
 *     the list beside it; accepted from the list, it is a relation in the
 *     bible, drawn on the map and saved;
 *   - on the plot board, "What happens between these?" in the gap between two
 *     neighbouring beats: the beat the stub proposes is a ghost card, and once
 *     accepted from the list it sits between the two in story order, with its
 *     two causal links.
 */
test.use({ baseURL: STUB_BASE_URL });

interface Book {
    slug: string;
    bookId: string;
}

async function newBook(page: Page, title: string): Promise<Book> {
    const slug = await signUp(page);
    const book = await page.request.post(`/api/w/${slug}/books`, { data: { title } });
    return { slug, bookId: ((await book.json()) as { book: { id: string } }).book.id };
}

async function element(page: Page, at: Book, kind: string, name: string, fields: Array<{ key: string; value: unknown }> = []): Promise<string> {
    const res = await page.request.post(`/api/w/${at.slug}/books/${at.bookId}/elements`, { data: { kind, name, fields } });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { element: { id: string } }).element.id;
}

async function canvasReady(page: Page) {
    await expect(page.locator('[data-story-canvas] .tlui-toolbar')).toBeVisible({ timeout: 20_000 });
}

async function answerAll(page: Page, words: string) {
    const main = page.getByRole('main');
    const cards = main.locator('[data-testid="round-questions"][data-round="1"]').getByTestId('question-card');
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    for (const card of await cards.all()) await answerCard(card, page, words);
    await main.locator('#round-finish').click();
    // The round closed and was reconciled (the next round may stream in after it).
    await expect(main.getByText(/bible changes? (was|were) proposed from this round|Round 2/).first()).toBeVisible({ timeout: 30_000 });
}

async function answerCard(card: Locator, page: Page, words: string) {
    const kind = await card.getAttribute('data-kind');
    if (kind === 'OPEN' || kind === 'SCENARIO') {
        await card.getByTestId('answer-text').fill(words);
        await page.keyboard.press('Control+Enter');
    } else {
        await card.getByTestId('answer-option').first().focus();
        await page.keyboard.press('1');
    }
    await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
}

test('relationship map: select two cards, Grill this, and the relation the answers state is a ghost until accepted from the list', async ({ page }) => {
    test.setTimeout(180_000);
    const at = await newBook(page, 'Salt Roads');
    const mara = await element(page, at, 'CHARACTER', 'Mara Vell');
    const tam = await element(page, at, 'CHARACTER', 'Tam Vell');
    const put = await page.request.put(`/api/w/${at.slug}/books/${at.bookId}/maps/relationship`, {
        data: {
            expectedVersion: 0,
            nodes: [
                { elementId: mara, x: 0, y: 0, w: 220, h: 88, lane: null },
                { elementId: tam, x: 520, y: 0, w: 220, h: 88, lane: null },
            ],
            edges: [],
            freeform: [],
        },
    });
    expect(put.status()).toBe(200);

    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/relationship`);
    await canvasReady(page);
    const grill = page.getByTestId('map-grill-this');
    await expect(grill).toHaveAttribute('data-selected', '0');
    // Near each card's top-left corner: tldraw's style panel may cover a card's right-hand side.
    const corner = async (id: string) => {
        const box = (await page.locator(`[data-story-node="${id}"]`).boundingBox())!;
        return { x: box.x + 24, y: box.y + 24 };
    };
    const a = await corner(mara);
    await page.mouse.click(a.x, a.y);
    const b = await corner(tam);
    await page.keyboard.down('Shift');
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up('Shift');
    await expect(grill).toHaveAttribute('data-selected', '2');
    await grill.click();
    await page.getByRole('dialog').locator('#interview-start').click();
    await expect(page).toHaveURL(/\/interviews\//);
    await answerAll(page, 'Mara Vell taught Tam Vell to read the tides on the salt roads.');

    // Back on the map: the proposed relation is a ghost line and an entry in the list, nothing in the bible yet.
    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/relationship`);
    await canvasReady(page);
    const list = page.getByTestId('structure-list');
    const proposed = list.getByTestId('new-relation-proposal');
    await expect(proposed).toHaveCount(1, { timeout: 20_000 });
    await expect(proposed).toContainText('Mara Vell');
    await expect(proposed).toContainText('Tam Vell');
    await expect(page.locator('[data-story-canvas] [data-ghost-edge]')).toHaveCount(1);
    await expect(page.locator('[data-story-canvas] [data-story-edge-label]')).toHaveCount(0);

    await proposed.getByRole('button', { name: /^Accept the relation/ }).click();
    await expect(page.getByText('Accepted. The relation is now in the bible.')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('structure-list')).toHaveCount(0, { timeout: 10_000 });
    // Drawn on the map and saved through the map's own save; no ghost left.
    await expect(page.locator('[data-story-canvas] [data-story-edge-label]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('[data-story-canvas] [data-ghost-edge]')).toHaveCount(0);
    await expect(page.getByTestId('map-save-status')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    const map = (await (await page.request.get(`/api/w/${at.slug}/books/${at.bookId}/maps/relationship`)).json()) as { map: { edges: Array<{ type: string }> } };
    expect(map.map.edges).toEqual([expect.objectContaining({ type: 'related_to' })]);
});

test('plot board: "What happens between these?" proposes a beat that, once accepted, sits between the two', async ({ page }) => {
    test.setTimeout(180_000);
    const at = await newBook(page, 'Flood Year');
    const first = await element(page, at, 'PLOT_BEAT', 'The bridge gives way', [{ key: 'act', value: 'opening' }]);
    const second = await element(page, at, 'PLOT_BEAT', 'The town turns on the mayor', [{ key: 'act', value: 'opening' }]);
    let after: string | null = null;
    for (const id of [first, second]) {
        const res = await page.request.post(`/api/w/${at.slug}/books/${at.bookId}/elements/${id}/order`, { data: { baseVersion: 1, after, before: null } });
        expect(res.status()).toBe(200);
        after = id;
    }
    await page.request.put(`/api/w/${at.slug}/books/${at.bookId}/maps/plot`, {
        data: { expectedVersion: 0, nodes: [first, second].map((elementId) => ({ elementId, x: 0, y: 0, w: 200, h: 88, lane: null })), edges: [], freeform: [] },
    });

    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/plot`);
    await canvasReady(page);
    const slot = page.locator(`[data-slot-after="${first}"][data-slot-before="${second}"]`);
    await expect(slot).toBeVisible();
    await slot.click();
    await page.getByRole('dialog').locator('#interview-start').click();
    await expect(page).toHaveURL(/\/interviews\//);
    await answerAll(page, 'Mara cuts the ferry rope and the crossing drifts toward the mayor.');

    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/plot`);
    await canvasReady(page);
    const beat = page.getByTestId('structure-new-element');
    await expect(beat).toHaveCount(1, { timeout: 20_000 });
    await expect(beat.getByTestId('slot-placement')).toContainText('The bridge gives way');
    await expect(page.locator('[data-story-canvas] [data-ghost-node]')).toHaveCount(1);

    await beat.getByRole('button', { name: /^Accept the new entry/ }).click();
    await expect(page.getByTestId('structure-new-element')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-story-canvas] [data-ghost-node]')).toHaveCount(0);
    // Its links, waiting until now, are accepted too.
    for (let i = 0; i < 2; i++) {
        await page.getByTestId('new-relation-proposal').first().getByRole('button', { name: /^Accept the relation/ }).click();
        await expect(page.getByTestId('new-relation-proposal')).toHaveCount(1 - i, { timeout: 10_000 });
    }
    await expect(page.getByTestId('map-save-status')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });

    // In the bible, the new beat sits between the two; on the map, between them in the lane.
    const listed = (await (await page.request.get(`/api/w/${at.slug}/books/${at.bookId}/elements?kind=PLOT_BEAT`)).json()) as { elements: Array<{ id: string; name: string; orderRank: string | null }> };
    const ranks = listed.elements.filter((e) => e.orderRank !== null).sort((a, b) => (a.orderRank! < b.orderRank! ? -1 : 1));
    expect(ranks.map((e) => e.id)).toEqual([first, expect.any(String), second]);
    const made = ranks[1].id;
    const y = async (id: string) => (await page.locator(`[data-story-node="${id}"]`).boundingBox())!.y;
    await expect(page.locator(`[data-story-node="${made}"]`)).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await y(first)) < (await y(made)) && (await y(made)) < (await y(second)), { timeout: 10_000 }).toBe(true);
});
