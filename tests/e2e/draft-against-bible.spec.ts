import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The draft held against the bible against the production build (Phase 5.3, D35), as an author with a fresh account:
 * a scene written in the editor reads "not read yet" in its Draft vs bible tab and on the Continuity page (rule 6: the
 * nightly reading has not run, so nothing is assessed — never "no mismatches"); the scene's card is filled in the Card
 * tab, saved only on Save, and survives a reload; "Grill me on this scene" is offered. No page breaks the content
 * security policy.
 */
test('an author fills a scene’s card and sees the draft not read yet', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            const w = window as unknown as { __cspViolations?: string[] };
            (w.__cspViolations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
        });
    });
    const slug = await signUp(page);
    const main = page.getByRole('main');
    const api = (bookId: string) => `/api/w/${slug}/books/${bookId}`;
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    const chapter = ((await (await page.request.post(`${api(book.id)}/manuscript/chapters`, { data: { title: 'One' } })).json()) as { id: string }).id;
    const scene = ((await (await page.request.post(`${api(book.id)}/manuscript/scenes`, { data: { chapterId: chapter, title: 'The quay' } })).json()) as { id: string }).id;

    await page.goto(`/w/${slug}/books/${book.id}/manuscript/scenes/${scene}`);
    const editor = main.getByTestId('scene-text').getByRole('textbox');
    await editor.click();
    await page.keyboard.type('Mara waited on the quay with the key in her fist.');
    await expect(main.getByTestId('scene-save')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

    // The Draft vs bible tab: the nightly reading has not run.
    await main.getByRole('radio', { name: 'Draft vs bible' }).click();
    await expect(main.getByTestId('scene-draft-status')).toHaveText('Not read yet: this scene is read overnight.');

    // The Card tab: filled and saved on Save, never on its own.
    await main.getByRole('radio', { name: 'Card' }).click();
    const card = main.getByTestId('scene-card');
    await expect(card.locator('#scene-card-goal')).toBeVisible();
    await expect(card.getByTestId('scene-grill')).toBeVisible();
    await card.locator('#scene-card-goal').fill('Hand over the key before the tide turns.');
    await card.locator('#scene-card-conflict').fill('The harbourmaster will not let her off the quay.');
    await card.locator('#scene-card-save').click();
    await expect(card.getByRole('status')).toHaveText('Saved.');
    await expect(card.getByTestId('scene-card-versions')).toContainText('Version 1');

    await page.reload();
    await main.getByRole('radio', { name: 'Card' }).click();
    await expect(main.locator('#scene-card-goal')).toHaveValue('Hand over the key before the tide turns.');
    await expect(main.locator('#scene-card-conflict')).toHaveValue('The harbourmaster will not let her off the quay.');

    // The Continuity page's Draft vs bible section: not read yet, never "no mismatches".
    await page.goto(`/w/${slug}/books/${book.id}/continuity`);
    const draft = main.locator('#continuity-draft');
    await expect(draft.getByRole('heading', { name: 'Draft vs bible' })).toBeVisible();
    await expect(draft.getByTestId('draft-reading')).toContainText('Not read yet');
    await expect(draft).not.toContainText('No mismatches');

    expect(await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])).toEqual([]);
});
