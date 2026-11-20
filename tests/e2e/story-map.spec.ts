import { expect, test, type Page } from '@playwright/test';
import { newCredentials, signIn, signUp } from './helpers';

/**
 * The story canvas platform (Phase 3.1) in a real browser against the
 * production build: open a book's plot board from the book, add an element
 * as a node, see it saved, reload and find it there. The canvas loads only
 * from our origin (no request to tldraw's CDN, no content-security violation),
 * tldraw's watermark is shown (decision D1), and two tabs editing one map meet
 * the version lock's notice rather than overwriting each other.
 */

async function bookWithElements(page: Page, names: string[]) {
    const slug = await signUp(page, newCredentials('canvas'));
    const book = await page.request.post(`/api/w/${slug}/books`, { data: { title: 'Lantern Street' } });
    const bookId = ((await book.json()) as { book: { id: string } }).book.id;
    const ids: string[] = [];
    for (const name of names) {
        const el = await page.request.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name } });
        ids.push(((await el.json()) as { element: { id: string } }).element.id);
    }
    return { slug, bookId, ids };
}

async function canvasReady(page: Page) {
    // The editor's own toolbar: tldraw shows nothing until its assets have loaded.
    await expect(page.locator('[data-story-canvas] .tlui-toolbar')).toBeVisible({ timeout: 20_000 });
}

async function addElement(page: Page, name: string) {
    await page.getByRole('main').getByRole('combobox', { name: 'Add an element' }).click();
    await page.getByPlaceholder('Search the book’s elements…').fill(name);
    await page.getByRole('option', { name }).click();
}

const saveStatus = (page: Page) => page.getByTestId('map-save-status');

test('open the plot board from the book, add an element, reload: the node is there, loaded from our origin only', async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const foreignRequests: string[] = [];
    const violations: string[] = [];
    page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.protocol.startsWith('http') && url.origin !== new URL(baseURL ?? 'http://localhost').origin) foreignRequests.push(url.host);
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
    });

    const { slug, bookId, ids } = await bookWithElements(page, ['Odile Marsh']);
    await page.goto(`/w/${slug}/books/${bookId}`);
    await page.locator('#book-map-plot').click();
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/maps/plot$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Plot board' })).toBeVisible();
    await canvasReady(page);
    // Decision D1: tldraw 3.x is used with its watermark showing.
    await expect(page.locator('[data-story-canvas] .tl-watermark_SEE-LICENSE')).toBeVisible();

    await addElement(page, 'Odile Marsh');
    const node = page.locator(`[data-story-node="${ids[0]}"]`);
    await expect(node).toContainText('Odile Marsh');
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });

    const stored = await page.request.get(`/api/w/${slug}/books/${bookId}/maps/plot`);
    const map = ((await stored.json()) as { map: { version: number; nodes: Array<{ elementId: string }> } }).map;
    expect(map.version).toBe(1);
    expect(map.nodes.map((n) => n.elementId)).toEqual([ids[0]]);

    await page.reload();
    await canvasReady(page);
    await expect(page.locator(`[data-story-node="${ids[0]}"]`)).toContainText('Odile Marsh');
    await expect(page.getByTestId('story-map-surface')).toHaveAttribute('data-map-version', '1');

    // The history lists the save.
    await page.getByTestId('map-history-open').click();
    await expect(page.getByTestId('canvas-history-row')).toHaveCount(1);

    expect(foreignRequests).toEqual([]);
    expect(violations).toEqual([]);
});

test('two tabs on one map: the second save is refused with a notice, and Reload shows the first tab’s map', async ({ browser }) => {
    test.setTimeout(120_000);
    const creds = newCredentials('canvas-two');
    const a = await (await browser.newContext()).newPage();
    const slug = await signUp(a, creds);
    const book = await a.request.post(`/api/w/${slug}/books`, { data: { title: 'Two tabs' } });
    const bookId = ((await book.json()) as { book: { id: string } }).book.id;
    for (const name of ['Ines Vale', 'Tomas Reed']) await a.request.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name } });
    const b = await (await browser.newContext()).newPage();
    await signIn(b, creds);
    await expect(b).toHaveURL(/\/w\//);
    const url = `/w/${slug}/books/${bookId}/maps/timeline`;
    await a.goto(url);
    await b.goto(url);
    await canvasReady(a);
    await canvasReady(b);

    await addElement(a, 'Ines Vale');
    await expect(saveStatus(a)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    // B still holds version 0: its save is refused, not applied over A's.
    await addElement(b, 'Tomas Reed');
    const notice = b.getByTestId('map-conflict-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    const stored = (await (await a.request.get(`/api/w/${slug}/books/${bookId}/maps/timeline`)).json()) as { map: { version: number; nodes: unknown[] } };
    expect(stored.map).toMatchObject({ version: 1, nodes: [expect.anything()] });

    await b.getByTestId('map-conflict-reload').click();
    await expect(notice).toBeHidden();
    await canvasReady(b);
    await expect(b.locator('[data-story-node]')).toHaveCount(1);
    await expect(b.locator('[data-story-node]')).toContainText('Ines Vale');
});

test('a sticky note is author text: typed on the canvas, saved, and there after a reload', async ({ page }) => {
    // tldraw's notes are rich text on TipTap; this is the path the TipTap
    // override (3.x for tldraw's own dependency, the 3.1 note) must keep working.
    test.setTimeout(90_000);
    const { slug, bookId } = await bookWithElements(page, []);
    await page.goto(`/w/${slug}/books/${bookId}/maps/relationship`);
    await canvasReady(page);
    await page.locator('[data-story-canvas] [data-testid="tools.note"]').click();
    const surface = page.locator('[data-story-canvas] .tl-canvas');
    const box = (await surface.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type('Ferry leaves at dawn');
    await page.keyboard.press('Escape');
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });

    const stored = (await (await page.request.get(`/api/w/${slug}/books/${bookId}/maps/relationship`)).json()) as { map: { freeform: Array<{ type: string }> } };
    expect(stored.map.freeform.map((r) => r.type)).toEqual(['note']);
    expect(JSON.stringify(stored.map.freeform)).toContain('Ferry leaves at dawn');

    await page.reload();
    await canvasReady(page);
    await expect(page.locator('[data-story-canvas] .tl-shape').filter({ hasText: 'Ferry leaves at dawn' })).toBeVisible();
});
