import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newCredentials, signUp } from './helpers';

/** axe (WCAG 2.1 A and AA), after entrance animations finish, as bible-a11y.spec.ts runs it. */
async function expectNoAxeViolations(page: Page, label: string, include?: string) {
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                .map((a) => a.finished.catch(() => undefined)),
        ),
    );
    let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    if (include) builder = builder.include(include);
    const { violations } = await builder.analyze();
    expect(violations.map((v) => `${label}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

/**
 * Phase 5.H-a against the production build:
 *   - a deleted scene waits in Recently deleted and comes back whole (issue #71); the manuscript says no AI writes it;
 *   - word search finds a scene's words and opens the editor at the match (D33 addendum A);
 *   - Settings says how Inkquisitor uses AI (D3), exports everything as an encrypted archive under a passphrase, and
 *     deletes the workspace, which its owner restores from the page a person with no workspace lands on (D36).
 */
test('a deleted scene is restored whole; search opens the editor at a scene’s words', async ({ page }) => {
    test.setTimeout(120_000);
    const slug = await signUp(page);
    const main = page.getByRole('main');
    const api = `/api/w/${slug}`;
    const book = ((await (await page.request.post(`${api}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    const m = `${api}/books/${book.id}/manuscript`;
    const chapter = (await (await page.request.post(`${m}/chapters`, { data: { title: 'The Harbour' } })).json()) as { id: string };
    const scene = (await (await page.request.post(`${m}/scenes`, { data: { chapterId: chapter.id, title: 'Low tide' } })).json()) as { id: string };
    const saved = await page.request.put(`${m}/scenes/${scene.id}/text`, { data: { html: '<p>The ferrywoman rowed past the breakwater at dusk.</p>', baseRevision: 0, checkpoint: true } });
    expect(saved.ok()).toBe(true);

    // Search from the board: the scene's word, and the editor opened at it.
    await page.goto(`/w/${slug}/books/${book.id}`);
    await main.locator('#book-search-input').fill('breakwater');
    const sceneLink = main.getByTestId('book-search-scene-link');
    await expect(sceneLink).toHaveText('Scene: Low tide');
    expect(await sceneLink.getAttribute('href')).toMatch(new RegExp(`/manuscript/scenes/${scene.id}\\?at=\\d+&len=\\d+$`));
    await sceneLink.click();
    await expect(page).toHaveURL(/\?at=\d+&len=\d+$/);
    await expect(main.getByTestId('scene-text').getByRole('textbox')).toContainText('breakwater');
    await expect(main.getByTestId('scene-d3-line')).toHaveText('No AI writes or rewrites your manuscript: its words are yours.');

    // Delete it from the outline (the undo toast lets it go), then restore it from Recently deleted.
    await page.goto(`/w/${slug}/books/${book.id}/manuscript`);
    await expect(main.getByTestId('manuscript-d3-line')).toBeVisible();
    await main.getByRole('button', { name: 'Delete Low tide' }).click();
    await expect(main.getByTestId('manuscript-scene')).toHaveCount(0);
    await expect.poll(async () => ((await (await page.request.get(`${m}/deleted-scenes`)).json()) as { scenes: unknown[] }).scenes.length, { timeout: 15_000 }).toBe(1);
    await page.reload();
    await main.locator('#manuscript-recently-deleted').click();
    await expect(main.getByTestId('deleted-scenes-table')).toContainText('Low tide');
    await expectNoAxeViolations(page, 'recently deleted scenes');
    await main.getByRole('button', { name: 'Restore Low tide' }).click();
    await expect(page).toHaveURL(new RegExp(`/manuscript/scenes/${scene.id}$`));
    await expect(main.getByTestId('scene-text').getByRole('textbox')).toContainText('The ferrywoman rowed past the breakwater at dusk.');
});

test('settings: how Inkquisitor uses AI, export everything, and a deleted workspace restored', async ({ page }) => {
    test.setTimeout(120_000);
    const creds = newCredentials('yourdata');
    const slug = await signUp(page, creds);
    const main = page.getByRole('main');
    await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } });
    await page.goto(`/w/${slug}/settings`);
    await expect(main.getByTestId('ai-use-d3')).toHaveText('No AI model writes or rewrites your manuscript. Every word of your scenes is yours.');
    await expectNoAxeViolations(page, 'settings');

    // Export: the passphrase is judged before it is sent; the archive downloads.
    await main.locator('#workspace-export-open').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#workspace-export-passphrase').fill('too short');
    await expect(dialog.locator('#workspace-export-submit')).toBeDisabled();
    await expectNoAxeViolations(page, 'export dialog', '[role="dialog"]');
    await dialog.locator('#workspace-export-passphrase').fill('salt roads at low tide');
    await dialog.locator('#workspace-export-passphrase-again').fill('salt roads at low tide');
    const download = page.waitForEvent('download');
    await dialog.locator('#workspace-export-submit').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/-inkquisitor-export-\d{4}-\d{2}-\d{2}\.zip$/);

    // Delete the workspace: its name typed exactly; it closes at once; its owner restores it.
    await main.locator('#workspace-delete-open').click();
    const del = page.getByRole('dialog');
    await expect(del.locator('#workspace-delete-submit')).toBeDisabled();
    await expectNoAxeViolations(page, 'delete dialog', '[role="dialog"]');
    await del.locator('#workspace-delete-confirm').fill(creds.workspaceName);
    await del.locator('#workspace-delete-submit').click();
    await expect(page).toHaveURL(/\/no-workspace$/, { timeout: 15_000 });
    expect((await page.request.get(`/api/w/${slug}/books`)).status()).toBe(404);
    const restorable = page.getByTestId('restorable-workspaces');
    await expect(restorable).toContainText(creds.workspaceName);
    await expectNoAxeViolations(page, 'no workspace, with a workspace to restore');
    await restorable.getByRole('button', { name: `Restore ${creds.workspaceName}` }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books$`), { timeout: 15_000 });
    await expect(main).toContainText('The Salt Roads');
});
