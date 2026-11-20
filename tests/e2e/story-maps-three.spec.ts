import { expect, test, type Page } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The three maps (Phase 3.2) in a real browser against the production build:
 *
 *   - on the relationship map, an arrow drawn between two characters the bible
 *     does not relate opens the type picker; picking a type creates the
 *     relation, which the element's page then shows, with the map embedded;
 *   - on the timeline, an event dragged along the axis moves in the bible's
 *     story order, and the order holds after a reload;
 *   - a node opens its element in a sheet without leaving the map.
 */

interface Created {
    slug: string;
    bookId: string;
}

async function newBook(page: Page, title: string): Promise<Created> {
    const slug = await signUp(page);
    const book = await page.request.post(`/api/w/${slug}/books`, { data: { title } });
    return { slug, bookId: ((await book.json()) as { book: { id: string } }).book.id };
}

async function element(page: Page, at: Created, kind: string, name: string, fields: Array<{ key: string; value: unknown }> = []): Promise<string> {
    const res = await page.request.post(`/api/w/${at.slug}/books/${at.bookId}/elements`, { data: { kind, name, fields } });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { element: { id: string } }).element.id;
}

async function canvasReady(page: Page) {
    await expect(page.locator('[data-story-canvas] .tlui-toolbar')).toBeVisible({ timeout: 20_000 });
}

const saveStatus = (page: Page) => page.getByTestId('map-save-status');

async function centreOf(page: Page, elementId: string) {
    const box = (await page.locator(`[data-story-node="${elementId}"]`).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('relationship map: draw an arrow, pick a type, and the relation is in the bible', async ({ page }) => {
    test.setTimeout(120_000);
    const at = await newBook(page, 'Salt Roads');
    const mara = await element(page, at, 'CHARACTER', 'Mara Vell');
    const tam = await element(page, at, 'CHARACTER', 'Tam Vell');
    // Both on the map, apart (saved through the map's own route, as the canvas saves).
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
    await expect(page.locator(`[data-story-node="${mara}"]`)).toBeVisible();

    await page.locator('[data-story-canvas] [data-testid="tools.arrow"]').click();
    const from = await centreOf(page, mara);
    const to = await centreOf(page, tam);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 8 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    const picker = page.getByRole('dialog', { name: 'How are these related?' });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    // Only what a character may be to a character, and "related to".
    await expect(picker.getByRole('radio', { name: 'Mara Vell member of Tam Vell' })).toHaveCount(0);
    await picker.getByRole('radio', { name: 'Mara Vell mentor of Tam Vell' }).click();
    await picker.getByRole('button', { name: 'Relate them' }).click();
    await expect(picker).toBeHidden();
    await expect(page.locator('[data-story-canvas] [data-story-edge-label]')).toHaveCount(1);
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });

    const map = (await (await page.request.get(`/api/w/${at.slug}/books/${at.bookId}/maps/relationship`)).json()) as { map: { edges: Array<{ type: string; sourceElementId: string }> } };
    expect(map.map.edges).toEqual([expect.objectContaining({ type: 'mentor_of', sourceElementId: mara })]);

    await page.goto(`/w/${at.slug}/books/${at.bookId}/elements/${mara}`);
    const main = page.getByRole('main');
    await expect(main.getByTestId('relations-panel')).toContainText('mentor of');
    await expect(main.getByTestId('relations-panel')).toContainText('Tam Vell');
    // The map, read-only, on the character's page, with Mara marked.
    const preview = main.getByTestId('map-preview-RELATIONSHIP');
    await expect(preview.getByRole('link', { name: /^Mara Vell Character/ })).toHaveAttribute('aria-current', 'true');
    await expect(preview.locator('line')).toHaveCount(1);
});

test('timeline: drag an event along the axis, and the story order holds after a reload', async ({ page }) => {
    test.setTimeout(120_000);
    const at = await newBook(page, 'Flood Year');
    const ids: string[] = [];
    for (const name of ['The levee breaks', 'The town empties', 'The water falls']) ids.push(await element(page, at, 'TIMELINE_EVENT', name, [{ key: 'story_time', value: `When ${name}` }]));
    // Placed in that order, through the order route; versions are 1 after creation.
    let after: string | null = null;
    for (const id of ids) {
        const res = await page.request.post(`/api/w/${at.slug}/books/${at.bookId}/elements/${id}/order`, { data: { baseVersion: 1, after, before: null } });
        expect(res.status()).toBe(200);
        after = id;
    }
    await page.request.put(`/api/w/${at.slug}/books/${at.bookId}/maps/timeline`, {
        data: { expectedVersion: 0, nodes: ids.map((elementId) => ({ elementId, x: 0, y: 0, w: 200, h: 88, lane: null })), edges: [], freeform: [] },
    });

    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/timeline`);
    await canvasReady(page);
    const xs = async () => Promise.all(ids.map(async (id) => (await centreOf(page, id)).x));
    const [x1, x2, x3] = await xs();
    expect(x1 < x2 && x2 < x3).toBe(true);
    // The event's time is its label.
    await expect(page.locator(`[data-story-node="${ids[0]}"]`)).toContainText('When The levee breaks');

    // Drag the last event to before the first.
    const last = await centreOf(page, ids[2]);
    const first = await centreOf(page, ids[0]);
    const moved = page.waitForResponse((r) => r.url().endsWith(`/elements/${ids[2]}/order`) && r.request().method() === 'POST');
    await page.mouse.move(last.x, last.y);
    await page.mouse.down();
    await page.mouse.move(first.x - 60, first.y, { steps: 12 });
    await page.mouse.move(first.x - 150, first.y, { steps: 6 });
    await page.mouse.up();
    expect((await moved).status()).toBe(200);
    await expect.poll(async () => {
        const [a, b, c] = await xs();
        return c < a && a < b;
    }).toBe(true);

    await page.reload();
    await canvasReady(page);
    const [r1, r2, r3] = await xs();
    expect(r3 < r1 && r1 < r2).toBe(true);
    // The bible holds it: the history of the moved event says so.
    const versions = (await (await page.request.get(`/api/w/${at.slug}/books/${at.bookId}/elements/${ids[2]}/versions`)).json()) as { versions: Array<{ movedInOrder: boolean }> };
    expect(versions.versions[0].movedInOrder).toBe(true);
});

test('a node opens its element in a sheet, edited without leaving the map', async ({ page }) => {
    test.setTimeout(120_000);
    const at = await newBook(page, 'Sheet');
    const beat = await element(page, at, 'PLOT_BEAT', 'The pardon refused', [{ key: 'act', value: 'opening' }]);
    await page.request.put(`/api/w/${at.slug}/books/${at.bookId}/maps/plot`, {
        data: { expectedVersion: 0, nodes: [{ elementId: beat, x: 0, y: 0, w: 200, h: 88, lane: null }], edges: [], freeform: [] },
    });
    await page.goto(`/w/${at.slug}/books/${at.bookId}/maps/plot`);
    await canvasReady(page);
    // The canvas takes the pointer, not the node's HTML: a double-click where the card is.
    const at2 = await centreOf(page, beat);
    await page.mouse.dblclick(at2.x, at2.y);
    const sheet = page.getByRole('dialog', { name: 'The pardon refused' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: /What the reader is left with/ }).fill('Will she go back?');
    await expect(sheet.getByTestId('element-sheet-save')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/maps/plot$`));
    const el = (await (await page.request.get(`/api/w/${at.slug}/books/${at.bookId}/elements/${beat}`)).json()) as { element: { fields: Array<{ key: string; value: unknown }> } };
    expect(el.element.fields.find((f) => f.key === 'reader_takeaway')!.value).toBe('Will she go back?');
});
