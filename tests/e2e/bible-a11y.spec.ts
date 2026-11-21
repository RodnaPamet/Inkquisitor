import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { SETUP_OPTIONS_TIMEOUT_MS, STUB_BASE_URL } from './stub-server';

/**
 * Accessibility of the bible pages (Phase 1.H, item 5), against the
 * production build:
 *
 *   - axe (WCAG 2.1 A and AA) finds nothing on the books list, the book
 *     board (and its word search with results, Phase 3.4), the element page's
 *     Fields and History tabs, the create and delete dialogs, and the
 *     recently-deleted page;
 *   - and on the interview pages and dialogs (Phase 2.4): the setup sheet, a
 *     session with a round open, the stop dialog and a book's interviews, and
 *     the review of an interview's proposed changes (Phase 2.5), and the
 *     Research page with a finished run (Phase 2.6) — against the
 *     stubbed-model server (and its worker), so a round really opens and a
 *     research run really runs;
 *   - and on the story maps (Phase 3.2): the relationship map, the plot
 *     board and the timeline (their own controls; tldraw's canvas is a
 *     third party's and is excluded), the type picker, the element sheet, and
 *     the read-only maps embedded on a character's, a beat's and an event's
 *     page; and (Phase 3.3) a map's list of proposed entries and links,
 *     decided by keyboard alone, and a relation's sheet;
 *   - an author can create, edit, relate and restore with the KEYBOARD ONLY:
 *     after the page is opened, every step is a key press — focus moves by
 *     Tab, controls answer Enter, Space, typing and the arrow keys — and no
 *     click is made.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoAxeViolations(page: Page, label: string, include?: string, exclude?: string) {
    // Let entrance animations (the layouts fade in) finish: mid-fade the text
    // is part-transparent, and its contrast is measured as such.
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => undefined)),
        ),
    );
    let builder = new AxeBuilder({ page }).withTags(WCAG);
    if (include) builder = builder.include(include);
    if (exclude) builder = builder.exclude(exclude);
    const { violations } = await builder.analyze();
    expect(
        violations.map((v) => `${label}: ${v.id} (${v.impact}) — ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`).join(' | ')}`),
        `${label} has axe violations`,
    ).toEqual([]);
}

/** Press Tab (or Shift+Tab) until `target` holds focus (reading the DOM is not interacting with it). */
async function tabTo(page: Page, target: Locator, options: { back?: boolean; max?: number } = {}) {
    for (let i = 0; i < (options.max ?? 80); i++) {
        if (await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
        await page.keyboard.press(options.back ? 'Shift+Tab' : 'Tab');
    }
    throw new Error(`Tab never reached ${target}`);
}

const saved = (page: Page) => expect(page.locator('[data-testid="save-status"]')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

async function bookWithCharacter(page: Page) {
    const slug = await signUp(page);
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'FACTION', name: 'The Tidewardens' } });
    const el = ((await (await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'CHARACTER', name: 'Mara' } })).json()) as {
        element: { id: string };
    }).element;
    const saved = await page.request.put(`/api/w/${slug}/books/${book.id}/elements/${el.id}/fields`, { data: { fields: [{ key: 'role', value: 'Ferrywoman' }], baseVersion: 1 } });
    expect(saved.status()).toBe(200);
    return { slug, bookId: book.id, elementId: el.id };
}

test('axe finds no WCAG 2.1 AA violation on the bible pages and dialogs', async ({ page }) => {
    test.setTimeout(120_000);
    const { slug, bookId, elementId } = await bookWithCharacter(page);
    const main = page.getByRole('main');

    await page.goto(`/w/${slug}/books`);
    await expect(main.getByRole('link', { name: 'The Salt Roads' })).toBeVisible();
    await expectNoAxeViolations(page, 'books list');

    await page.goto(`/w/${slug}/books/${bookId}`);
    await expect(main.locator('[data-kind="CHARACTER"]')).toContainText('Mara');
    await expectNoAxeViolations(page, 'book board');
    // Word search (Phase 3.4): the box and a result with its highlighted snippet.
    await main.locator('#book-search-input').fill('tidewarden');
    await expect(main.getByTestId('book-search-hit').first()).toContainText('The Tidewardens');
    await expectNoAxeViolations(page, 'book board, word search results');
    await main.locator('#create-element').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page, 'create element dialog', '[role="dialog"]');
    await page.keyboard.press('Escape');
    await main.locator('#delete-book-open').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoAxeViolations(page, 'delete book dialog', '[role="dialog"]');
    await page.keyboard.press('Escape');

    await page.goto(`/w/${slug}/books/${bookId}/elements/${elementId}`);
    await expect(main.getByTestId('field-richtext-wound').getByTestId('rich-text-editor-content')).toBeVisible();
    await expectNoAxeViolations(page, 'element page, fields');
    await main.getByRole('tab', { name: 'History' }).click();
    await expect(main.getByTestId('version-diff-body')).toBeVisible();
    await expect(main.getByTestId('history-diff')).toHaveAttribute('aria-busy', 'false');
    await expectNoAxeViolations(page, 'element page, history');

    await page.goto(`/w/${slug}/deleted-books`);
    await expect(main.getByRole('heading', { level: 1, name: 'Recently deleted' })).toBeVisible();
    await expectNoAxeViolations(page, 'recently deleted');

    // Phase 4.0: the source library's pages, empty (the stubbed-model spec walks them full).
    await page.goto(`/w/${slug}/books/${bookId}/sources`);
    await expect(main.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();
    await expectNoAxeViolations(page, 'book sources');
    await page.goto(`/w/${slug}/books/${bookId}/facts`);
    await expect(main.getByRole('heading', { level: 1, name: 'Facts' })).toBeVisible();
    await expectNoAxeViolations(page, 'book facts');
    await page.goto(`/w/${slug}/series`);
    await expect(main.getByRole('heading', { level: 1, name: 'Series library' })).toBeVisible();
    await expectNoAxeViolations(page, 'series library');
    await page.goto(`/w/${slug}/series/facts`);
    await expect(main.getByRole('heading', { level: 1, name: 'Series facts' })).toBeVisible();
    await expectNoAxeViolations(page, 'series facts');
});

test('axe finds no WCAG 2.1 AA violation on the story maps, the type picker, the element sheet and the embedded maps (Phase 3.2)', async ({ page }) => {
    test.setTimeout(150_000);
    const { slug, bookId, elementId } = await bookWithCharacter(page);
    const main = page.getByRole('main');
    const api = `/api/w/${slug}/books/${bookId}`;
    const create = async (kind: string, name: string, fields: Array<{ key: string; value: unknown }> = []) =>
        ((await (await page.request.post(`${api}/elements`, { data: { kind, name, fields } })).json()) as { element: { id: string } }).element.id;
    const tam = await create('CHARACTER', 'Tam');
    const beat = await create('PLOT_BEAT', 'The pardon refused', [{ key: 'act', value: 'opening' }]);
    const event = await create('TIMELINE_EVENT', 'The flood', [{ key: 'story_time', value: 'Spring' }]);
    await page.request.post(`${api}/elements/${event}/order`, { data: { baseVersion: 1, after: null, before: null } });
    const node = (id: string, x: number) => ({ elementId: id, x, y: 0, w: 220, h: 88, lane: null });
    await page.request.put(`${api}/maps/relationship`, { data: { expectedVersion: 0, nodes: [node(elementId, 0), node(tam, 520)], edges: [], freeform: [] } });
    await page.request.put(`${api}/maps/plot`, { data: { expectedVersion: 0, nodes: [node(beat, 0)], edges: [], freeform: [] } });
    await page.request.put(`${api}/maps/timeline`, { data: { expectedVersion: 0, nodes: [node(event, 0)], edges: [], freeform: [] } });
    const canvasReady = () => expect(page.locator('[data-story-canvas] .tlui-toolbar')).toBeVisible({ timeout: 20_000 });

    await page.goto(`/w/${slug}/books/${bookId}/maps/relationship`);
    await canvasReady();
    await expectNoAxeViolations(page, 'relationship map', undefined, '[data-story-canvas]');
    // The type picker: an arrow from one character to the other.
    await page.locator('[data-story-canvas] [data-testid="tools.arrow"]').click();
    const box = async (id: string) => (await page.locator(`[data-story-node="${id}"]`).boundingBox())!;
    const [a, b] = [await box(elementId), await box(tam)];
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole('dialog', { name: 'How are these related?' })).toBeVisible({ timeout: 10_000 });
    await expectNoAxeViolations(page, 'type picker', '[role="dialog"]');
    await page.getByRole('button', { name: 'Cancel' }).click();
    // The element sheet, opened from the toolbar by keyboard-reachable controls.
    await main.getByRole('combobox', { name: 'Open an element' }).click();
    await page.getByRole('option', { name: 'Tam' }).click();
    await expect(page.getByRole('dialog', { name: 'Tam' }).getByTestId('element-sheet-body')).toBeVisible();
    await expectNoAxeViolations(page, 'element sheet', '[role="dialog"]');
    await page.keyboard.press('Escape');

    await page.goto(`/w/${slug}/books/${bookId}/maps/plot`);
    await canvasReady();
    await expectNoAxeViolations(page, 'plot board', undefined, '[data-story-canvas]');
    await page.goto(`/w/${slug}/books/${bookId}/maps/timeline`);
    await canvasReady();
    await expectNoAxeViolations(page, 'timeline', undefined, '[data-story-canvas]');

    for (const [id, map, label] of [
        [elementId, 'RELATIONSHIP', 'character page with its relationship map'],
        [beat, 'PLOT', 'plot beat page with its plot board'],
        [event, 'TIMELINE', 'timeline event page with its timeline'],
    ] as const) {
        await page.goto(`/w/${slug}/books/${bookId}/elements/${id}`);
        await expect(main.getByTestId(`map-preview-${map}`)).toBeVisible();
        await expectNoAxeViolations(page, label);
    }
});

test('create, edit, relate and restore with the keyboard alone', async ({ page }) => {
    test.setTimeout(120_000);
    const { slug, bookId } = await bookWithCharacter(page);
    const main = page.getByRole('main');
    await page.goto(`/w/${slug}/books/${bookId}`);
    await expect(main.locator('[data-kind="CHARACTER"]')).toContainText('Mara');

    // CREATE: the board's create button, the kind, the name, submit.
    await tabTo(page, main.locator('#create-element'));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await tabTo(page, dialog.locator('#create-element-kind'));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Character');
    await expect(page.getByRole('option', { name: 'Character', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('#create-element-kind')).toContainText('Character');
    await tabTo(page, dialog.locator('#create-element-name'));
    await page.keyboard.type('Tam');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/elements/[^/]+$`), { timeout: 15_000 });
    await expect(main.getByRole('heading', { level: 1, name: 'Tam' })).toBeVisible();

    // EDIT: a field, autosaved; then a second edit, so there is a version to go back to.
    await tabTo(page, main.getByTestId('field-input-role'));
    await page.keyboard.type('Ferryman');
    await saved(page);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Ferryman of the south');
    await saved(page);

    // RELATE: the relation type, then the other element by search, then Link.
    await tabTo(page, main.locator('#relation-type'));
    await page.keyboard.press('Enter');
    await page.keyboard.type('member of');
    await expect(page.getByRole('option', { name: 'member of', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await tabTo(page, main.locator('#relation-other'));
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tide');
    await expect(page.getByRole('option', { name: /The Tidewardens/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(main.locator('#relation-other')).toContainText('The Tidewardens');
    await tabTo(page, main.locator('#relation-add'));
    await page.keyboard.press('Enter');
    await expect(main.getByTestId('relations-panel')).toContainText('member of The Tidewardens');

    // RESTORE: the History tab — the tablist is one tab stop, the active tab;
    // the arrow key moves to History and selects it — then an older version's Restore.
    await tabTo(page, main.getByRole('tab', { name: 'Fields' }), { back: true });
    await page.keyboard.press('ArrowRight');
    await expect(main.getByRole('tab', { name: 'History' })).toBeFocused();
    await expect(main.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    await expect(main.getByTestId('version-list').getByRole('listitem')).toHaveCount(3);
    await tabTo(page, main.getByTestId('restore-2'));
    await page.keyboard.press('Enter');
    await expect(main.getByTestId('version-list').getByRole('listitem')).toHaveCount(4);
    await expect(main.getByTestId('version-list').getByRole('listitem').first()).toContainText('Restored from version 2');
    // The tabs are one tab stop: back to the active one, then the arrow key to its neighbour.
    await tabTo(page, main.getByRole('tab', { name: 'History' }), { back: true });
    await page.keyboard.press('ArrowLeft');
    await expect(main.getByRole('tab', { name: 'Fields' })).toBeFocused();
    await expect(main.getByTestId('field-input-role')).toHaveValue('Ferryman');
});

test.describe('the interview pages (Phase 2.4, the stubbed-model server)', () => {
    test.use({ baseURL: STUB_BASE_URL });

    test('axe finds no WCAG 2.1 AA violation on the setup sheet, a session, the stop dialog and the interviews list', async ({ page }) => {
        test.setTimeout(120_000);
        const { slug, bookId, elementId } = await bookWithCharacter(page);
        const main = page.getByRole('main');
        await page.goto(`/w/${slug}/books/${bookId}/elements/${elementId}`);
        await main.locator('#element-enrich').click();
        await expect(page.getByRole('dialog').getByTestId('depth-preview')).toBeVisible({ timeout: SETUP_OPTIONS_TIMEOUT_MS });
        await expectNoAxeViolations(page, 'interview setup sheet', '[role="dialog"]');
        await page.getByRole('dialog').locator('#interview-start').click();
        await expect(main.getByTestId('question-card').first()).toBeVisible({ timeout: 20_000 });
        await expectNoAxeViolations(page, 'interview session, round open');
        await main.locator('#interview-stop').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expectNoAxeViolations(page, 'stop interview dialog', '[role="dialog"]');
        await page.keyboard.press('Escape');
        await page.goto(`/w/${slug}/books/${bookId}/interviews`);
        await expect(main.getByTestId('interviews-table')).toContainText('Mara');
        await expectNoAxeViolations(page, 'interviews list');
    });

    /** An interview whose first round is answered and closed through the API, so the close reconciles it (Phase 2.5). */
    async function reconciledInterview(page: Page) {
        const { slug, bookId, elementId } = await bookWithCharacter(page);
        const api = page.request;
        const base = `/api/w/${slug}/books/${bookId}/interviews`;
        const started = (await (await api.post(base, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } })).json()) as {
            interview: { session: { id: string }; round: { number: number; questions: Array<{ id: string; kind: string; options: string[] | null }> } };
        };
        const { session, round } = started.interview;
        for (const q of round.questions) {
            const data = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'She keeps the ledger of every crossing.' };
            expect((await api.post(`${base}/${session.id}/questions/${q.id}/answer`, { data })).ok()).toBe(true);
        }
        const closed = (await (await api.post(`${base}/${session.id}/rounds/${round.number}/close`, { data: {} })).json()) as { reconcile: { status: string } | null };
        expect(closed.reconcile?.status).toBe('DONE');
        return { slug, bookId, sessionId: session.id };
    }

    test('axe finds no WCAG 2.1 AA violation on the review of proposed changes, nor while one is edited (Phase 2.5)', async ({ page }) => {
        test.setTimeout(120_000);
        const { slug, bookId, sessionId } = await reconciledInterview(page);
        const main = page.getByRole('main');
        await page.goto(`/w/${slug}/books/${bookId}/interviews/${sessionId}/review`);
        await expect(main.getByTestId('field-proposal').first()).toBeVisible({ timeout: 20_000 });
        await expectNoAxeViolations(page, 'review of proposed changes');
        await main.getByTestId('field-proposal').first().getByRole('button', { name: 'Edit, then accept' }).click();
        await expectNoAxeViolations(page, 'review, a proposal being edited');
    });

    /** Two characters on the relationship map and an interview about both, reconciled: the stub proposes the link between them (Phase 3.3). */
    async function proposedLink(page: Page) {
        const { slug, bookId, elementId } = await bookWithCharacter(page);
        const api = page.request;
        const tam = ((await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Tam' } })).json()) as { element: { id: string } }).element.id;
        const node = (id: string, x: number) => ({ elementId: id, x, y: 0, w: 220, h: 88, lane: null });
        await api.put(`/api/w/${slug}/books/${bookId}/maps/relationship`, { data: { expectedVersion: 0, nodes: [node(elementId, 0), node(tam, 520)], edges: [], freeform: [] } });
        const base = `/api/w/${slug}/books/${bookId}/interviews`;
        const started = (await (await api.post(base, { data: { scope: 'SELECTION', elementIds: [elementId, tam], relationIds: [], depth: 2, detail: 3 } })).json()) as {
            interview: { session: { id: string }; round: { number: number; questions: Array<{ id: string; kind: string; options: string[] | null }> } };
        };
        const { session, round } = started.interview;
        for (const q of round.questions) {
            const data = q.kind === 'CHOICE' || q.kind === 'EITHER_OR' ? { choice: q.options![0] } : q.kind === 'SCALE' ? { scale: 3 } : { text: 'Mara taught Tam to read the tides.' };
            expect((await api.post(`${base}/${session.id}/questions/${q.id}/answer`, { data })).ok()).toBe(true);
        }
        const closed = (await (await api.post(`${base}/${session.id}/rounds/${round.number}/close`, { data: {} })).json()) as { reconcile: { status: string } | null };
        expect(closed.reconcile?.status).toBe('DONE');
        return { slug, bookId, elementId };
    }

    test('axe finds no WCAG 2.1 AA violation on a map’s list of proposed entries and links, nor on a relation’s sheet; the list is decided by keyboard alone (Phase 3.3)', async ({ page }) => {
        test.setTimeout(150_000);
        const { slug, bookId, elementId } = await proposedLink(page);
        const main = page.getByRole('main');
        await page.goto(`/w/${slug}/books/${bookId}/maps/relationship`);
        const list = main.getByTestId('structure-list');
        await expect(list.getByTestId('new-relation-proposal')).toHaveCount(1, { timeout: 20_000 });
        await expectNoAxeViolations(page, 'a map’s list of proposed entries and links', '[data-testid="structure-list"]');
        await tabTo(page, list.getByRole('button', { name: /^Accept the relation/ }));
        await page.keyboard.press('Enter');
        await expect(main.getByTestId('structure-list')).toHaveCount(0, { timeout: 10_000 });

        await page.goto(`/w/${slug}/books/${bookId}/elements/${elementId}`);
        await main.getByTestId('relations-panel').getByTestId('relation-open').first().click();
        await expect(page.getByRole('dialog').getByTestId('relation-sheet')).toBeVisible({ timeout: 10_000 });
        await expectNoAxeViolations(page, 'a relation’s sheet', '[role="dialog"]');
    });

    test('accept a proposed change with the keyboard alone (Phase 2.5)', async ({ page }) => {
        test.setTimeout(120_000);
        const { slug, bookId, sessionId } = await reconciledInterview(page);
        const main = page.getByRole('main');
        await page.goto(`/w/${slug}/books/${bookId}/interviews/${sessionId}/review`);
        const first = main.getByTestId('field-proposal').first();
        await expect(first).toBeVisible({ timeout: 20_000 });
        await tabTo(page, first.getByRole('button', { name: /^Accept the change/ }));
        await page.keyboard.press('Enter');
        await expect(first.getByTestId('proposal-status')).toHaveText('Accepted', { timeout: 10_000 });
    });

    test('start an interview, answer and finish a round with the keyboard alone', async ({ page }) => {
        test.setTimeout(120_000);
        const { slug, bookId, elementId } = await bookWithCharacter(page);
        const main = page.getByRole('main');
        await page.goto(`/w/${slug}/books/${bookId}/elements/${elementId}`);
        await expect(main.getByRole('heading', { level: 1, name: 'Mara' })).toBeVisible();

        // Enrich, then Start in the sheet: Tab and Enter.
        await tabTo(page, main.locator('#element-enrich'));
        await page.keyboard.press('Enter');
        const sheet = page.getByRole('dialog');
        await expect(sheet.getByTestId('depth-preview')).toBeVisible({ timeout: SETUP_OPTIONS_TIMEOUT_MS });
        await tabTo(page, sheet.locator('#interview-start'));
        await page.keyboard.press('Enter');

        // The round opens with focus in its first question. A number key picks
        // (and saves), Enter moves on; a written answer is typed and Ctrl+Enter
        // saves it and moves on. After the last, focus is on Finish round.
        const cards = main.getByTestId('question-card');
        await expect(cards.first()).toBeVisible({ timeout: 20_000 });
        const count = await cards.count();
        const focusWithin = (el: Locator) => el.evaluate((node) => node.contains(document.activeElement));
        for (let i = 0; i < count; i++) {
            const card = cards.nth(i);
            await expect.poll(() => focusWithin(card)).toBe(true);
            const kind = await card.getAttribute('data-kind');
            if (kind === 'OPEN' || kind === 'SCENARIO') {
                await page.keyboard.type('She keeps the ledger of every crossing.');
                await page.keyboard.press('Control+Enter');
                await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
            } else {
                await page.keyboard.press('1');
                await expect(card).toHaveAttribute('data-status', 'ANSWERED', { timeout: 10_000 });
                await page.keyboard.press('Enter');
            }
        }
        await expect(main.locator('#round-finish')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(main.locator('[data-testid="round-questions"][data-round="2"]')).toBeVisible({ timeout: 20_000 });
    });
});

test.describe('the Research page (Phase 2.6, the stubbed-model server and its worker)', () => {
    test.use({ baseURL: STUB_BASE_URL });

    /** A book whose brief has run to the end, its finding and proposal on the page. */
    async function researched(page: Page) {
        const { slug, bookId, elementId } = await bookWithCharacter(page);
        const base = `/api/w/${slug}/books/${bookId}/research`;
        const brief = (await (await page.request.post(`${base}/briefs`, { data: { question: 'How did medieval falconers train hawks?', purpose: 'Believable methods.', scopeElementIds: [elementId], depth: 'QUICK' } })).json()) as { brief: { id: string } };
        expect((await page.request.post(`${base}/briefs/${brief.brief.id}/runs`)).status()).toBe(202);
        await page.goto(`/w/${slug}/books/${bookId}/research`);
        const main = page.getByRole('main');
        await expect(main.getByTestId('run-summary').first()).toHaveAttribute('data-outcome', 'OK', { timeout: 90_000 });
        await expect(main.getByTestId('research-field-proposal').first()).toBeVisible({ timeout: 20_000 });
        return { slug, bookId };
    }

    test('axe finds no WCAG 2.1 AA violation on the Research page: the brief form, a run, its findings and proposals', async ({ page }) => {
        test.setTimeout(180_000);
        await researched(page);
        await expectNoAxeViolations(page, 'research page with a finished run');
        await page.getByRole('main').getByTestId('research-field-proposal').first().getByRole('button', { name: 'Edit, then accept' }).click();
        await expectNoAxeViolations(page, 'research page, a proposal being edited');
    });

    test('write a brief and accept a research proposal with the keyboard alone', async ({ page }) => {
        test.setTimeout(180_000);
        await researched(page);
        const main = page.getByRole('main');
        // A brief: focus moves by Tab, text is typed, the depth is chosen with the arrow keys.
        await tabTo(page, main.locator('#brief-question'));
        await page.keyboard.type('What did a Victorian lighthouse keeper do each night?');
        await tabTo(page, main.locator('#brief-purpose'));
        await page.keyboard.type('My keeper is alone on the rock.');
        await tabTo(page, main.locator('#brief-depth-QUICK'));
        // The arrow moves focus (Radix moves it on a timer, so whether the arrow ALSO checks it races the
        // key's release); Space checks the focused radio, as it does for any keyboard user.
        await page.keyboard.press('ArrowDown');
        await expect(main.locator('#brief-depth-STANDARD')).toBeFocused();
        await page.keyboard.press('Space');
        await expect(main.locator('#brief-depth-STANDARD')).toBeChecked();
        await tabTo(page, main.locator('#brief-submit'));
        await page.keyboard.press('Enter');
        await expect(main.getByTestId('research-brief').first()).toContainText('Victorian lighthouse keeper', { timeout: 10_000 });
        // The earlier run's proposal, accepted by keyboard.
        const proposal = main.getByTestId('research-field-proposal').first();
        await tabTo(page, proposal.getByRole('button', { name: /^Accept the change/ }), { max: 200 });
        await page.keyboard.press('Enter');
        await expect(proposal.getByTestId('proposal-status')).toHaveText('Accepted', { timeout: 10_000 });
    });
});

