import { expect, test } from '@playwright/test';
import { escapeRegExp } from '../helpers/escape-regexp';
import { signUp } from './helpers';

/**
 * Word search on the book board (Phase 3.4), against the production build:
 * a stemmed variant of a word in an element's field finds the element, its
 * snippet highlights the word as written, the query travels in a POST body
 * and never in a URL, and the result opens the element — by keyboard.
 */
test('finds an element by a stemmed variant, highlights the word, and opens it', async ({ page }) => {
    const slug = await signUp(page);
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    const created = await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, {
        data: { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'want', value: 'She rowed across the drowned country every morning.' }] },
    });
    expect(created.status()).toBe(201);
    const { element } = (await created.json()) as { element: { id: string } };
    await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'CHARACTER', name: 'Jon', summary: 'A miller who never leaves the shore.' } });

    const searches: Array<{ method: string; url: string; body: string | null }> = [];
    page.on('request', (r) => {
        if (new URL(r.url()).pathname.endsWith('/search')) searches.push({ method: r.method(), url: r.url(), body: r.postData() });
    });

    await page.goto(`/w/${slug}/books/${book.id}`);
    const main = page.getByRole('main');
    const box = main.getByLabel('Search this book');
    await box.click();
    await page.keyboard.type('rowing');

    const hits = main.getByTestId('book-search-hit');
    await expect(main.getByTestId('book-search-status')).toHaveText('1 result');
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('Mara');
    await expect(hits.first()).toContainText('Conscious want');
    await expect(hits.first().locator('mark')).toHaveText(['rowed']);

    // The query was a POST body, never part of a URL.
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) {
        expect(s.method).toBe('POST');
        expect(s.url).not.toContain('rowing');
        expect(JSON.parse(s.body ?? '{}')).toEqual({ q: expect.stringMatching(/^r/) });
    }
    expect(page.url()).not.toContain('rowing');

    // A phrase needs its words in order.
    await box.fill('"every morning"');
    await expect(hits).toHaveCount(1);
    await box.fill('"morning every"');
    await expect(main.getByTestId('book-search-status')).toHaveText('Nothing in this book matches.');

    // Back to the result, and open it with the keyboard.
    await box.fill('rowing');
    const link = hits.first().getByRole('link', { name: 'Mara' });
    await expect(link).toBeVisible();
    await box.focus();
    for (let i = 0; i < 10 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(`/books/${book.id}/elements/${element.id}`)}$`));
});
