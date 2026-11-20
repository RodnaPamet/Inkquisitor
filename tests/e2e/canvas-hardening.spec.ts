import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { newCredentials, signIn, signUp } from './helpers';

/**
 * Hardening Phase 3's canvas (3.H) in a real browser against the production
 * build:
 *
 *   - Arrange runs in a Web Worker: the layout worker loads under the static
 *     assets' own policy (`default-src 'none'`, so it must be one chunk), the
 *     map is laid out and saved, and no content-security violation is raised.
 *   - Two tabs on one DERIVED map (the plot board) and on the relationship map
 *     with a relation created in tab B: the version lock refuses the stale
 *     save with its notice, and no write is lost — the other tab's version is
 *     in the history, and the bible keeps the relation.
 *   - The list view: every canvas action by keyboard alone (relate through the
 *     type picker, question a relation, open an element, remove a relation,
 *     move a beat in the story order, restore a version), and axe finds
 *     nothing on it.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoAxeViolations(page: Page, label: string, include?: string) {
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => undefined)),
        ),
    );
    let builder = new AxeBuilder({ page }).withTags(WCAG).exclude('[data-story-canvas]');
    if (include) builder = builder.include(include);
    const { violations } = await builder.analyze();
    expect(
        violations.map((v) => `${label}: ${v.id} (${v.impact}) — ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`).join(' | ')}`),
        `${label} has axe violations`,
    ).toEqual([]);
}

/** Press Tab (or Shift+Tab, `back`) until `target` holds focus (reading the DOM is not interacting with it). */
async function tabTo(page: Page, target: Locator, options: { back?: boolean; max?: number } = {}) {
    for (let i = 0; i < (options.max ?? 120); i++) {
        if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
        await page.keyboard.press(options.back ? 'Shift+Tab' : 'Tab');
    }
    throw new Error(`Tab never reached ${target}`);
}

async function book(page: Page, slug: string, title: string) {
    return ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title } })).json()) as { book: { id: string } }).book.id;
}

async function element(page: Page, api: string, kind: string, name: string, fields: Array<{ key: string; value: unknown }> = []) {
    return ((await (await page.request.post(`${api}/elements`, { data: { kind, name, fields } })).json()) as { element: { id: string } }).element.id;
}

const node = (elementId: string, x: number, y = 0) => ({ elementId, x, y, w: 220, h: 88, lane: null });
const canvasReady = (page: Page) => expect(page.locator('[data-story-canvas] .tlui-toolbar')).toBeVisible({ timeout: 20_000 });
const saveStatus = (page: Page) => page.getByTestId('map-save-status');
const mapOf = async (page: Page, api: string, kind: string) =>
    ((await (await page.request.get(`${api}/maps/${kind}`)).json()) as { map: { version: number; nodes: Array<{ elementId: string; x: number; y: number }>; edges: Array<{ relationId: string }> } }).map;

test('arrange runs in the layout worker, under the static assets’ policy, with no violation, and the arranged map is saved', async ({ page }) => {
    test.setTimeout(120_000);
    const violations: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|importScripts|worker/i.test(msg.text())) violations.push(msg.text());
    });
    page.on('pageerror', (err) => violations.push(err.message));
    const slug = await signUp(page, newCredentials('arrange'));
    const bookId = await book(page, slug, 'Arranged');
    const api = `/api/w/${slug}/books/${bookId}`;
    const ids = [];
    for (const name of ['Ada', 'Bea', 'Cyd', 'Dov', 'Eli']) ids.push(await element(page, api, 'CHARACTER', name));
    // All on one spot: any layout moves them.
    await page.request.put(`${api}/maps/relationship`, { data: { expectedVersion: 0, nodes: ids.map((id) => node(id, 0, 0)), edges: [], freeform: [] } });

    await page.goto(`/w/${slug}/books/${bookId}/maps/relationship`);
    await canvasReady(page);
    await page.getByTestId('map-arrange-lr').click();
    await expect(page.getByTestId('story-map-surface')).toHaveAttribute('data-layout-thread', 'worker', { timeout: 15_000 });
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    const map = await mapOf(page, api, 'relationship');
    expect(map.version).toBe(2);
    expect(new Set(map.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(ids.length);
    expect(violations).toEqual([]);
});

test('two tabs on the plot board (a derived map): the stale save is refused, and the other tab’s version stays in the history', async ({ browser }) => {
    test.setTimeout(150_000);
    const creds = newCredentials('plot-two');
    const a = await (await browser.newContext()).newPage();
    const slug = await signUp(a, creds);
    const bookId = await book(a, slug, 'Two tabs, one board');
    const api = `/api/w/${slug}/books/${bookId}`;
    const first = await element(a, api, 'PLOT_BEAT', 'The pardon refused', [{ key: 'act', value: 'opening' }]);
    await element(a, api, 'PLOT_BEAT', 'The tide turns', [{ key: 'act', value: 'opening' }]);
    await element(a, api, 'PLOT_BEAT', 'The ferry burns', [{ key: 'act', value: 'crisis' }]);
    await a.request.put(`${api}/maps/plot`, { data: { expectedVersion: 0, nodes: [node(first, 0)], edges: [], freeform: [] } });

    const b = await (await browser.newContext()).newPage();
    await signIn(b, creds);
    await expect(b).toHaveURL(/\/w\//);
    const url = `/w/${slug}/books/${bookId}/maps/plot`;
    await a.goto(url);
    await b.goto(url);
    await canvasReady(a);
    await canvasReady(b);
    await expect(a.getByTestId('story-map-surface')).toHaveAttribute('data-map-version', '1');
    await expect(b.getByTestId('story-map-surface')).toHaveAttribute('data-map-version', '1');

    // A adds a beat: version 2.
    await a.getByRole('main').getByRole('combobox', { name: 'Add an element' }).click();
    await a.getByPlaceholder('Search the book’s elements…').fill('The tide turns');
    await a.getByRole('option', { name: 'The tide turns' }).click();
    await expect(saveStatus(a)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    expect((await mapOf(a, api, 'plot')).version).toBe(2);

    // B, still at version 1, adds another: refused, with the notice.
    await b.getByRole('main').getByRole('combobox', { name: 'Add an element' }).click();
    await b.getByPlaceholder('Search the book’s elements…').fill('The ferry burns');
    await b.getByRole('option', { name: 'The ferry burns' }).click();
    const notice = b.getByTestId('map-conflict-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    expect((await mapOf(a, api, 'plot')).version).toBe(2);

    // B chooses to save its edits over the newer version: a NEW version; A's stays in the history.
    await notice.getByRole('button', { name: 'Save mine over it' }).click();
    await expect(notice).toBeHidden();
    await expect(saveStatus(b)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    const after = await mapOf(a, api, 'plot');
    expect(after.version).toBe(3);
    const v2 = ((await (await a.request.get(`${api}/maps/plot/snapshots/2`)).json()) as { snapshot: { nodes: Array<{ elementId: string }> } }).snapshot;
    expect(v2.nodes).toHaveLength(2);
    const history = ((await (await a.request.get(`${api}/maps/plot/snapshots`)).json()) as { snapshots: Array<{ version: number }> }).snapshots;
    expect(history.map((s) => s.version)).toEqual([3, 2, 1]);
});

test('two tabs on the relationship map, a relation created in tab B: A’s stale save is refused, and Reload shows B’s edge', async ({ browser }) => {
    test.setTimeout(150_000);
    const creds = newCredentials('rel-two');
    const a = await (await browser.newContext()).newPage();
    const slug = await signUp(a, creds);
    const bookId = await book(a, slug, 'Two tabs, one web');
    const api = `/api/w/${slug}/books/${bookId}`;
    const mara = await element(a, api, 'CHARACTER', 'Mara Vell');
    const tam = await element(a, api, 'CHARACTER', 'Tam Vell');
    await element(a, api, 'CHARACTER', 'Odile Marsh');
    await a.request.put(`${api}/maps/relationship`, { data: { expectedVersion: 0, nodes: [node(mara, 0), node(tam, 520)], edges: [], freeform: [] } });

    const b = await (await browser.newContext()).newPage();
    await signIn(b, creds);
    await expect(b).toHaveURL(/\/w\//);
    const url = `/w/${slug}/books/${bookId}/maps/relationship`;
    await a.goto(url);
    await b.goto(url);
    await canvasReady(a);
    await canvasReady(b);

    // B relates Mara to Tam (in its list view): the relation is created in the bible and drawn; B saves version 2.
    await b.locator('#map-view-list').click();
    await b.getByRole('combobox', { name: /From/ }).click();
    await b.getByRole('option', { name: 'Mara Vell' }).click();
    // One list open at a time: the From list has closed before To opens.
    await expect(b.getByRole('option')).toHaveCount(0);
    await b.getByRole('combobox', { name: /To/ }).click();
    await b.getByRole('option', { name: 'Tam Vell' }).click();
    await b.getByTestId('map-list-relate').click();
    const picker = b.getByRole('dialog', { name: 'How are these related?' });
    await picker.getByRole('radio', { name: 'Mara Vell mentor of Tam Vell' }).click();
    await picker.getByRole('button', { name: 'Relate them' }).click();
    await expect(picker).toBeHidden();
    await expect(b.getByTestId('map-list-relation')).toHaveCount(1);
    await expect(saveStatus(b)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    const afterB = await mapOf(b, api, 'relationship');
    expect(afterB.version).toBe(2);
    expect(afterB.edges).toHaveLength(1);

    // A, still at version 1, adds Odile: refused, with the notice; B's edge is not overwritten.
    await a.getByRole('main').getByRole('combobox', { name: 'Add an element' }).click();
    await a.getByPlaceholder('Search the book’s elements…').fill('Odile Marsh');
    await a.getByRole('option', { name: 'Odile Marsh' }).click();
    const notice = a.getByTestId('map-conflict-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    expect(await mapOf(a, api, 'relationship')).toMatchObject({ version: 2, edges: [{ relationId: afterB.edges[0].relationId }] });

    await a.getByTestId('map-conflict-reload').click();
    await expect(notice).toBeHidden();
    await canvasReady(a);
    await expect(a.getByTestId('story-map-surface')).toHaveAttribute('data-map-version', '2');
    await expect(a.locator('[data-story-canvas] .tl-shape').filter({ hasText: 'mentor of' })).toHaveCount(1);
    // The relation is the bible's: it is there whatever the map shows.
    const relations = ((await (await a.request.get(`${api}/elements/${mara}`)).json()) as { element: { relations: Array<{ id: string }> } }).element.relations;
    expect(relations.map((r) => r.id)).toContain(afterB.edges[0].relationId);
});

test('the list view: every canvas action by keyboard alone, and axe finds nothing', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page, newCredentials('list'));
    const bookId = await book(page, slug, 'The keyboard map');
    const api = `/api/w/${slug}/books/${bookId}`;
    const mara = await element(page, api, 'CHARACTER', 'Mara Vell');
    const tam = await element(page, api, 'CHARACTER', 'Tam Vell');
    await element(page, api, 'CHARACTER', 'Odile Marsh');
    await page.request.put(`${api}/maps/relationship`, { data: { expectedVersion: 0, nodes: [node(mara, 0), node(tam, 520)], edges: [], freeform: [] } });

    await page.goto(`/w/${slug}/books/${bookId}/maps/relationship`);
    await canvasReady(page);
    const list = page.getByTestId('map-list-view');

    // The view toggle is a radio group: arrow keys move to "List".
    await tabTo(page, page.locator('#map-view-canvas'));
    await page.keyboard.press('ArrowRight');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('story-map-surface')).toBeHidden();
    await expectNoAxeViolations(page, 'map list view');

    // Add an element from the toolbar's picker.
    await tabTo(page, page.getByRole('main').getByRole('combobox', { name: 'Add an element' }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Odile');
    await expect(page.getByRole('option', { name: 'Odile Marsh' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(list.getByTestId('map-list-element')).toHaveCount(3);
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });

    // Relate two elements: From, To, Relate, then the type picker by keys.
    await tabTo(page, page.getByRole('combobox', { name: /From/ }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Mara');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option')).toHaveCount(0);
    await tabTo(page, page.getByRole('combobox', { name: /To/ }));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Odile');
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByTestId('map-list-relate'));
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'How are these related?' });
    await expect(picker).toBeVisible();
    await expectNoAxeViolations(page, 'type picker from the list', '[role="dialog"]');
    await tabTo(page, picker.getByRole('radio').first());
    await page.keyboard.press('Space');
    await tabTo(page, picker.getByRole('button', { name: 'Relate them' }));
    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(list.getByTestId('map-list-relation')).toHaveCount(1);
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    expect((await mapOf(page, api, 'relationship')).edges).toHaveLength(1);
    await expectNoAxeViolations(page, 'map list view with a relation');

    // Question the relation: the interview setup sheet opens, scoped to it; its Cancel closes it.
    await tabTo(page, list.getByTestId('map-list-question'));
    await page.keyboard.press('Enter');
    const setup = page.getByRole('dialog').filter({ has: page.getByTestId('interview-setup') });
    await expect(setup).toBeVisible();
    await tabTo(page, setup.getByRole('button', { name: 'Cancel' }));
    await page.keyboard.press('Enter');
    await expect(setup).toBeHidden();

    // Open an element: its sheet; Escape closes it.
    await tabTo(page, list.getByRole('button', { name: 'Open Tam Vell' }), { back: true });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Tam Vell' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Tam Vell' })).toBeHidden();

    // Remove the relation: gone from the list at once, with the undo toast.
    await tabTo(page, list.getByTestId('map-list-remove-edge'));
    await page.keyboard.press('Enter');
    await expect(list.getByTestId('map-list-relation')).toHaveCount(0);

    // Remove an element from the map, then restore the version that had it, by keys.
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    await tabTo(page, list.getByRole('button', { name: 'Remove from map: Odile Marsh' }), { back: true });
    await page.keyboard.press('Enter');
    await expect(list.getByTestId('map-list-element')).toHaveCount(2);
    await expect(saveStatus(page)).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
    await tabTo(page, page.getByTestId('map-history-open'), { back: true });
    await page.keyboard.press('Enter');
    const rows = page.getByTestId('canvas-history-row');
    await expect(rows.first()).toBeVisible();
    const withOdile = rows.filter({ hasText: '3 nodes' }).first();
    await tabTo(page, withOdile.getByTestId('canvas-history-restore'));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByTestId('canvas-history-confirm-restore'));
    await page.keyboard.press('Enter');
    await expect(list.getByTestId('map-list-element')).toHaveCount(3, { timeout: 15_000 });
});

test('the plot board’s list: a beat moves in the story order by keyboard', async ({ page }) => {
    test.setTimeout(120_000);
    const slug = await signUp(page, newCredentials('list-plot'));
    const bookId = await book(page, slug, 'The ordered board');
    const api = `/api/w/${slug}/books/${bookId}`;
    const one = await element(page, api, 'PLOT_BEAT', 'The pardon refused', [{ key: 'act', value: 'opening' }]);
    const two = await element(page, api, 'PLOT_BEAT', 'The tide turns', [{ key: 'act', value: 'opening' }]);
    await page.request.post(`${api}/elements/${one}/order`, { data: { baseVersion: 1, after: null, before: null } });
    await page.request.post(`${api}/elements/${two}/order`, { data: { baseVersion: 1, after: one, before: null } });
    await page.request.put(`${api}/maps/plot`, { data: { expectedVersion: 0, nodes: [node(one, 0), node(two, 0)], edges: [], freeform: [] } });

    await page.goto(`/w/${slug}/books/${bookId}/maps/plot`);
    await canvasReady(page);
    await tabTo(page, page.locator('#map-view-canvas'));
    await page.keyboard.press('ArrowRight');
    const opening = page.getByRole('list', { name: 'Opening' });
    await expect(opening.getByTestId('map-list-element')).toHaveCount(2);
    const order = () => opening.getByTestId('map-list-element').evaluateAll((els) => els.map((e) => e.getAttribute('data-element-id')));
    expect(await order()).toEqual([one, two]);
    await expectNoAxeViolations(page, 'plot board list view');

    await tabTo(page, opening.getByRole('button', { name: 'Earlier: The tide turns' }));
    await page.keyboard.press('Enter');
    await expect.poll(order, { timeout: 15_000 }).toEqual([two, one]);
});
