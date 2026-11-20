import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * Accessibility of the bible pages (Phase 1.H, item 5), against the
 * production build:
 *
 *   - axe (WCAG 2.1 A and AA) finds nothing on the books list, the book
 *     board, the element page's Fields and History tabs, the create and
 *     delete dialogs, and the recently-deleted page;
 *   - and on the interview pages and dialogs (Phase 2.4): the setup sheet, a
 *     session with a round open, the stop dialog and a book's interviews —
 *     against the stubbed-model server, so a round really opens;
 *   - an author can create, edit, relate and restore with the KEYBOARD ONLY:
 *     after the page is opened, every step is a key press — focus moves by
 *     Tab, controls answer Enter, Space, typing and the arrow keys — and no
 *     click is made.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoAxeViolations(page: Page, label: string, include?: string) {
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
        await expect(page.getByRole('dialog').getByTestId('depth-preview')).toBeVisible();
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
        await expect(sheet.getByTestId('depth-preview')).toBeVisible();
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
