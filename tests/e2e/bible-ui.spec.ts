import { expect, test, type Page } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The bible UI against the production build (Phase 1.2), as an author with a
 * fresh account: create a book, create a character, edit a field (autosaved),
 * see the edit in the history, restore an older version, relate the
 * character to a faction, and delete it through the undo toast — Undo first,
 * then for real. No page on the way may break the content security policy
 * (the rich-text editor's chunks load through the nonce).
 */

const saved = (page: Page) => expect(page.locator('[data-testid="save-status"]')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

test('an author keeps a bible through the UI: create, edit, history, restore, relate, delete with undo', async ({ page }) => {
    test.setTimeout(120_000);
    const violations: string[] = [];
    page.on('console', (msg) => {
        if (/Content[- ]Security[- ]Policy|Refused to (?:execute|load|apply|connect)/i.test(msg.text())) violations.push(msg.text());
    });
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            const w = window as unknown as { __cspViolations?: string[] };
            (w.__cspViolations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
        });
    });
    const slug = await signUp(page);
    const main = page.getByRole('main');

    // A book, from the books list.
    await main.locator('#create-book').click();
    const bookDialog = page.getByRole('dialog');
    await bookDialog.locator('#create-book-title').fill('The Salt Roads');
    await bookDialog.locator('#create-book-submit').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/[^/]+$`));
    const bookUrl = page.url();
    const bookId = new URL(bookUrl).pathname.split('/')[4];
    await expect(main.getByRole('heading', { level: 1, name: 'The Salt Roads' })).toBeVisible();
    const characterCard = main.locator('[data-kind="CHARACTER"]');
    await expect(characterCard).toContainText('Not started');

    // A character, from the board.
    await main.locator('#create-element').click();
    const elementDialog = page.getByRole('dialog');
    await elementDialog.locator('#create-element-kind').click();
    await page.getByRole('option', { name: 'Character', exact: true }).click();
    await elementDialog.locator('#create-element-name').fill('Mara');
    await elementDialog.locator('#create-element-submit').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${bookId}/elements/[^/]+$`));
    const elementUrl = page.url();
    await expect(main.getByRole('heading', { level: 1, name: 'Mara' })).toBeVisible();
    // The rich-text editors mounted (their chunk loaded and ran under the policy).
    await expect(main.getByTestId('field-richtext-wound').getByTestId('rich-text-editor-content')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])).toEqual([]);

    // Two edits, each autosaved: versions 2 and 3.
    const role = main.getByTestId('field-input-role');
    await role.fill('Ferrywoman');
    await saved(page);
    await role.fill('Ferrywoman of the north');
    await saved(page);
    await page.reload();
    await expect(main.getByTestId('field-input-role')).toHaveValue('Ferrywoman of the north');

    // The board now measures the character.
    await page.goto(bookUrl);
    await expect(characterCard.getByRole('progressbar')).toBeVisible();
    await expect(characterCard).toContainText(/1 of \d+ fields filled/);
    await page.goto(elementUrl);

    // The history shows the edit, and restores an older version as a new one.
    await main.getByRole('tab', { name: 'History' }).click();
    const versions = main.getByTestId('version-list');
    await expect(versions.getByRole('listitem')).toHaveCount(3);
    const diff = main.getByTestId('version-diff-body');
    await expect(diff.getByTestId('version-diff-added')).toContainText('Role in the story: Ferrywoman of the north');
    await expect(diff.getByTestId('version-diff-removed')).toContainText('Role in the story: Ferrywoman');
    await main.getByTestId('restore-2').click();
    await expect(versions.getByRole('listitem')).toHaveCount(4);
    await expect(versions.getByRole('listitem').first()).toContainText('Restored from version 2');
    await main.getByRole('tab', { name: 'Fields' }).click();
    await expect(main.getByTestId('field-input-role')).toHaveValue('Ferrywoman');

    // A faction to relate to (through the API), then the relation through the picker.
    const faction = await page.request.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'FACTION', name: 'The Tidewardens' } });
    expect(faction.status()).toBe(201);
    await page.reload();
    await main.locator('#relation-type').click();
    await page.getByRole('option', { name: 'member of', exact: true }).click();
    await main.locator('#relation-other').click();
    await page.getByRole('option', { name: /The Tidewardens/ }).click();
    await main.locator('#relation-add').click();
    const relations = main.getByTestId('relations-panel');
    await expect(relations).toContainText('member of The Tidewardens');

    // Delete through the undo toast: Undo keeps the character...
    await main.locator('#element-delete').click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(main.getByTestId('field-input-role')).toBeVisible();
    await page.waitForTimeout(6_000);
    await expect(page).toHaveURL(elementUrl);

    // ...and without it, the character is deleted when the window closes.
    await main.locator('#element-delete').click();
    await expect(page).toHaveURL(bookUrl, { timeout: 15_000 });
    await expect(characterCard).toContainText('Not started');
    const gone = await page.request.get(`/api/w/${slug}/books/${bookId}/elements`);
    expect(((await gone.json()).elements as Array<{ name: string }>).map((e) => e.name)).toEqual(['The Tidewardens']);
    expect(violations).toEqual([]);
});
