import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * Deleting a book and bringing it back (Phase 1.H, item 7), through the UI:
 * the dialog offers the export first (a real download), deletes only once
 * the title is typed, the book leaves the list and its pages 404, and its
 * OWNER restores it from Recently deleted, whole.
 */
test('delete a book after exporting it, then restore it from Recently deleted', async ({ page }) => {
    test.setTimeout(90_000);
    const slug = await signUp(page);
    const main = page.getByRole('main');
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'Doomed Voyage' } })).json()) as { book: { id: string } }).book;
    const el = await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'THEME', name: 'Loss' } });
    expect(el.status()).toBe(201);

    await page.goto(`/w/${slug}/books/${book.id}`);
    await main.locator('#delete-book-open').click();
    const dialog = page.getByRole('dialog');
    const downloading = page.waitForEvent('download');
    await dialog.locator('#delete-book-export-bundle').click();
    expect((await downloading).suggestedFilename()).toBe('doomed-voyage-bible.zip');

    const submit = dialog.locator('#delete-book-submit');
    await expect(submit).toBeDisabled();
    await dialog.locator('#delete-book-confirm').fill('Doomed Voyage');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books$`));
    await expect(main.getByRole('link', { name: 'Doomed Voyage' })).toHaveCount(0);
    expect((await page.request.get(`/api/w/${slug}/books/${book.id}`)).status()).toBe(404);
    expect((await page.goto(`/w/${slug}/books/${book.id}`))?.status()).toBe(404);

    await page.goto(`/w/${slug}/books`);
    await main.locator('#deleted-books-link').click();
    await expect(main.getByRole('heading', { level: 1, name: 'Recently deleted' })).toBeVisible();
    await main.getByRole('button', { name: 'Restore Doomed Voyage' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${book.id}$`));
    await expect(main.locator('[data-kind="THEME"]')).toContainText('Loss');
});
