import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * Bible export and import against the production build (Phase 1.3), as an
 * author with a fresh account: export a book's bible from its home as a
 * Markdown zip (a real browser download), import that zip into another book
 * through the import modal, see the report and the elements on the board;
 * export the second book and get the same bytes; download the PDF; bring in
 * a concept note.
 */

test('an author exports a bible, imports it into another book, and sees the elements', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;
    const main = page.getByRole('main');

    // A source book with a little of everything, made through the API.
    const source = (await (await api.post(base, { data: { title: 'The Salt Roads' } })).json()).book.id as string;
    const make = async (data: object) => (await (await api.post(`${base}/${source}/elements`, { data })).json()).element.id as string;
    const mara = await make({ kind: 'CHARACTER', name: 'Mara Vell', fields: [{ key: 'speaking_voice', value: '<p>Short <strong>clipped</strong> sentences.</p>' }, { key: 'agency', value: 4 }] });
    const guild = await make({ kind: 'FACTION', name: 'The Salt Guild' });
    await make({ kind: 'CUSTOM', name: 'Tide tables', customLabel: 'Almanac', fields: [{ key: 'key_details', value: ['Spring tides'] }] });
    expect((await api.post(`${base}/${source}/relations`, { data: { fromElementId: mara, toElementId: guild, type: 'member_of', note: 'Reluctantly' } })).status()).toBe(201);

    // Export from the book's home: a real download, named for the book.
    await page.goto(`/w/${slug}/books/${source}`);
    const downloading = page.waitForEvent('download');
    await main.locator('#export-bundle').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('the-salt-roads-bible.zip');
    const zipPath = testInfo.outputPath('the-salt-roads-bible.zip');
    await download.saveAs(zipPath);

    // An empty book to import into.
    const target = (await (await api.post(base, { data: { title: 'Empty shelf' } })).json()).book.id as string;
    await page.goto(`/w/${slug}/books/${target}`);
    await expect(main.locator('[data-kind="CHARACTER"]')).toContainText('Not started');
    await main.locator('#import-open').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#import-bundle-file').setInputFiles(zipPath);
    // Take the bundle's title and details too, so the book is a copy of the source.
    await dialog.locator('#import-apply-book-details').click();
    await dialog.locator('#import-submit').click();
    const report = dialog.getByTestId('import-report');
    await expect(report).toContainText('3 created, 0 updated, 0 unchanged');
    await expect(report).toContainText('3 versions written');
    await expect(report).toContainText('Relations: 1 added');
    await expect(report).toContainText("The book's title and details were updated.");
    await dialog.locator('#import-done').click();

    // The board shows them (the modal refreshed the page behind it).
    await expect(main.locator('[data-kind="CHARACTER"]')).toContainText('Mara Vell');
    await expect(main.locator('[data-kind="FACTION"]')).toContainText('The Salt Guild');
    await expect(main.locator('[data-kind="CUSTOM"]')).toContainText('Tide tables');

    await expect(main.getByRole('heading', { level: 1, name: 'The Salt Roads' })).toBeVisible();

    // The imported book exports to the same bytes as the source.
    const again = await api.get(`${base}/${target}/export/bundle`);
    expect(again.status()).toBe(200);
    expect(Buffer.from(await again.body()).equals(fs.readFileSync(zipPath))).toBe(true);

    // A second import of the same zip changes nothing.
    await main.locator('#import-open').click();
    await dialog.locator('#import-bundle-file').setInputFiles(zipPath);
    await dialog.locator('#import-submit').click();
    await expect(dialog.getByTestId('import-report')).toContainText('0 created, 0 updated, 3 unchanged');
    await expect(dialog.getByTestId('import-report')).toContainText('No versions written');
    await dialog.locator('#import-done').click();

    // The PDF.
    const pdf = await api.get(`${base}/${source}/export/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect(pdf.headers()['content-disposition']).toBe('attachment; filename="the-salt-roads-bible.pdf"');
    expect(Buffer.from(await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // A concept note, pasted.
    await main.locator('#import-open').click();
    await dialog.getByRole('radio', { name: 'Concept note' }).click();
    await dialog.locator('#import-note-name').fill('First pitch');
    await dialog.locator('#import-note-text').fill('A ferrywoman crosses a drowned country.\n\nShe owes the guild.');
    await dialog.locator('#import-submit').click();
    await expect(dialog.getByTestId('import-report')).toContainText('Created the research note “First pitch”.');
    await dialog.locator('#import-done').click();
    await expect(main.locator('[data-kind="RESEARCH"]')).toContainText('First pitch');
});
