import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The prose checks against the production build and the real worker (Phase 5.2, D34), as an author with a fresh
 * account: a style sheet (American spelling), a scene typed in the editor; a few seconds after the author stops,
 * notes appear in the margin (no model anywhere: deterministic checks in the worker); one is dismissed and stays
 * gone; a spelling suggestion is drawn as a suggestion, accepted, and the edit reaches the server through the
 * autosave (it survives a reload). The manuscript page shows the settings; a rule turned off hides its notes.
 */
test('an author writes, sees notes in the margin, dismisses one and accepts a suggestion', async ({ page }) => {
    test.setTimeout(120_000);
    const slug = await signUp(page);
    const main = page.getByRole('main');
    const api = (bookId: string) => `/api/w/${slug}/books/${bookId}`;
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    const sheet = await page.request.post(`${api(book.id)}/elements`, {
        data: { kind: 'STYLE', name: 'House style', fields: [{ key: 'style_scope', value: 'whole_book' }, { key: 'check_spelling', value: 'american' }] },
    });
    expect(sheet.status()).toBe(201);
    const chapter = ((await (await page.request.post(`${api(book.id)}/manuscript/chapters`, { data: { title: 'One' } })).json()) as { id: string }).id;
    const scene = ((await (await page.request.post(`${api(book.id)}/manuscript/scenes`, { data: { chapterId: chapter, title: 'The quay' } })).json()) as { id: string }).id;

    await page.goto(`/w/${slug}/books/${book.id}/manuscript/scenes/${scene}`);
    const margin = main.getByTestId('prose-notes-margin');
    const editor = main.getByTestId('scene-text').getByRole('textbox');
    await editor.click();
    await page.keyboard.type('She saw the sea. The colour of the sky faded.');
    await expect(main.getByTestId('scene-save')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

    // A few seconds after the last keystroke, the worker's notes reach the margin.
    const notes = margin.getByTestId('prose-note');
    await expect(margin.getByTestId('prose-notes-status')).toHaveAttribute('data-status', 'CHECKED', { timeout: 40_000 });
    await expect(margin.locator('[data-rule="filter-words"]')).toHaveCount(1);
    await expect(margin.locator('[data-rule="spelling-variant"]')).toHaveCount(1);
    expect(await notes.count()).toBeGreaterThanOrEqual(2);
    await expect(editor.locator('.prose-note').first()).toBeVisible();

    // Dismiss the filter-word note: it leaves the margin and the text, and stays gone on a reload.
    await margin.locator('[data-rule="filter-words"]').getByTestId('prose-note-button').click();
    await margin.getByTestId('prose-dismiss').click();
    await expect(margin.locator('[data-rule="filter-words"]')).toHaveCount(0);

    // The spelling note: its suggestion is drawn, nothing changes until it is accepted.
    await margin.locator('[data-rule="spelling-variant"]').getByTestId('prose-note-button').click();
    await expect(editor.locator('.prose-suggest-insert')).toHaveText('color');
    await expect(editor.locator('.prose-suggest-delete')).toHaveText('colour');
    await expect(editor).toContainText('The colour');
    await margin.getByTestId('prose-accept').click();
    await expect(editor).toContainText('The color of the sky faded.');
    await expect(editor.locator('.prose-suggest-insert')).toHaveCount(0);
    await expect(main.getByTestId('scene-save')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

    // The accepted edit was the editor's own save: the stored text holds it, and the dismissed note stays dismissed.
    await page.reload();
    await expect(editor).toContainText('She saw the sea. The color of the sky faded.');
    await expect(margin.getByTestId('prose-notes-status')).toHaveAttribute('data-status', 'CHECKED', { timeout: 40_000 });
    await expect(margin.locator('[data-rule="spelling-variant"]')).toHaveCount(0);
    await expect(margin.locator('[data-rule="filter-words"]')).toHaveCount(0);

    // The book's settings, on the manuscript page: the sheet in use, the rules, the dismissed count.
    await page.goto(`/w/${slug}/books/${book.id}/manuscript`);
    const settings = main.getByTestId('prose-check-settings');
    await expect(settings.getByTestId('prose-style-sheet')).toContainText('House style');
    await expect(settings.locator('#prose-alex')).not.toBeChecked();
    await expect(settings.getByTestId('prose-dismissals')).toContainText('1 dismissed note.');
});
