import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The manuscript against the production build (Phase 5.1, D33), as an author with a fresh account: add a chapter
 * and a scene from the outline, write in the scene editor (autosaved; the text survives a reload), mention a
 * character with @ (the side panel then shows it with its summary), set a session goal, name a plot beat the scene
 * dramatises (the beat's page lists the scene), see the version history, and import a Markdown draft after
 * confirming its split. No page breaks the content security policy (the editor's chunk loads through the nonce).
 */
test('an author writes a scene: outline, autosave, mention, goal, beat, history and an import', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
            const w = window as unknown as { __cspViolations?: string[] };
            (w.__cspViolations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
        });
    });
    const slug = await signUp(page);
    const main = page.getByRole('main');
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'The Salt Roads' } })).json()) as { book: { id: string } }).book;
    await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'CHARACTER', name: 'Mara Quell', summary: 'A ferrywoman who never crosses at night.' } });
    const beat = ((await (await page.request.post(`/api/w/${slug}/books/${book.id}/elements`, { data: { kind: 'PLOT_BEAT', name: 'The night crossing' } })).json()) as { element: { id: string } }).element;

    // The outline: from the board, a chapter and a scene.
    await page.goto(`/w/${slug}/books/${book.id}`);
    await main.locator('#book-manuscript').click();
    await expect(main.getByRole('heading', { level: 1, name: 'Manuscript' })).toBeVisible();
    await expect(main.getByTestId('manuscript-totals')).toHaveText('Not started: no scene yet.');
    await main.locator('#manuscript-add-chapter').click();
    await expect(main.getByTestId('manuscript-chapter')).toHaveCount(1);
    await main.getByRole('button', { name: 'Add scene to Chapter 1' }).click();
    await expect(main.getByTestId('manuscript-scene')).toHaveCount(1);
    await main.getByTestId('manuscript-scene').getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books/${book.id}/manuscript/scenes/[^/]+$`));
    const sceneUrl = page.url();

    // Write; mention a character with @.
    const editor = main.getByTestId('scene-text').getByRole('textbox');
    await editor.click();
    await page.keyboard.type('The tide was high when ');
    await page.keyboard.type('@Mar');
    await expect(page.getByTestId('mention-picker').getByRole('option', { name: /Mara Quell/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type('reached the slip.');
    await expect(editor.locator('[data-mention]')).toHaveText('@Mara Quell');
    await expect(main.getByTestId('scene-save')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await expect(main.getByTestId('scene-words')).toHaveText('Scene: 10 words');

    // The side panel's linked elements: the mention, with its summary.
    await main.getByRole('radio', { name: 'Linked' }).click();
    const link = main.getByTestId('scene-link');
    await expect(link).toContainText('Mara Quell');
    await expect(link).toContainText('A ferrywoman who never crosses at night.');
    await expect(link).toContainText('Mentioned');

    // A session goal: progress over this tab's session, nothing stored.
    await main.locator('#session-goal-input').fill('20');
    await main.locator('#session-goal-save').click();
    await expect(main.getByTestId('session-goal')).toContainText('of 20 this session');

    // The scene dramatises a beat; the beat's page lists it.
    await main.getByRole('radio', { name: 'Details' }).click();
    await main.locator('#scene-beat-add').click();
    await page.getByRole('option', { name: 'The night crossing' }).click();
    await expect(main.getByTestId('scene-beats')).toContainText('The night crossing');

    // Autosaved: the text survives a reload; the first save wrote the first version.
    await page.reload();
    await expect(main.getByTestId('scene-text').getByRole('textbox')).toContainText('The tide was high when @Mara Quell reached the slip.');
    await main.getByRole('radio', { name: 'History' }).click();
    await expect(main.getByTestId('scene-version-list').getByRole('listitem').first()).toContainText('Version 1');

    await page.goto(`/w/${slug}/books/${book.id}/elements/${beat.id}`);
    await expect(main.getByTestId('beat-scenes')).toContainText('Untitled scene');

    // An import: the split is shown, adjusted and confirmed.
    await page.goto(`/w/${slug}/books/${book.id}/manuscript`);
    await main.locator('#manuscript-import').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#manuscript-import-file').setInputFiles({
        name: 'draft.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Chapter two\n\n## The quay\n\nThe harbour master counted barrels.\n\n***\n\nRain all week.\n\n# Chapter three\n\n## Home\n\nThe end.\n'),
    });
    await dialog.locator('#manuscript-import-read').click();
    await expect(dialog.getByTestId('manuscript-import-summary')).toContainText('This makes 1 part, 2 chapters and 2 scenes.');
    await dialog.locator('#manuscript-import-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(main.getByTestId('manuscript-chapter')).toHaveCount(3);
    await expect(main.getByTestId('manuscript-scene')).toHaveCount(4);
    await page.goto(sceneUrl);
    await expect(main.getByTestId('scene-text').getByRole('textbox')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])).toEqual([]);
});

test('a save over a newer revision is refused, never applied, and the page reads the stored text', async ({ page }) => {
    test.setTimeout(60_000);
    const slug = await signUp(page);
    const book = ((await (await page.request.post(`/api/w/${slug}/books`, { data: { title: 'Read only' } })).json()) as { book: { id: string } }).book;
    const chapter = ((await (await page.request.post(`/api/w/${slug}/books/${book.id}/manuscript/chapters`, { data: { title: 'One' } })).json()) as { id: string }).id;
    const scene = ((await (await page.request.post(`/api/w/${slug}/books/${book.id}/manuscript/scenes`, { data: { chapterId: chapter } })).json()) as { id: string }).id;
    await page.request.put(`/api/w/${slug}/books/${book.id}/manuscript/scenes/${scene}/text`, { data: { html: '<p>Read me.</p>', baseRevision: 0 } });
    // A second tab's save names the revision it read: a stale one is refused, never applied.
    const stale = await page.request.put(`/api/w/${slug}/books/${book.id}/manuscript/scenes/${scene}/text`, { data: { html: '<p>Lost.</p>', baseRevision: 0 } });
    expect(stale.status()).toBe(409);
    expect(((await stale.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('VERSION_CONFLICT');
    await page.goto(`/w/${slug}/books/${book.id}/manuscript/scenes/${scene}`);
    await expect(page.getByRole('main').getByTestId('scene-text').getByRole('textbox')).toContainText('Read me.');
    await expect(page.getByRole('main').locator('#session-goal-input')).toBeVisible();
});
