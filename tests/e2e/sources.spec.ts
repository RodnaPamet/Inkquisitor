import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * The source library end to end (Phase 4.0, D23), on the production build with
 * the STUBBED MODEL (D13) and the worker: the author uploads a small DOCX on a
 * book's Sources page, sees its cost and confirms it; the background job reads
 * the passage (the stub states one fact a sentence); on the Facts page the
 * author confirms the character's want, quoted from the draft; an interview
 * started afterwards does not ask the want.
 */
test.use({ baseURL: STUB_BASE_URL });

function docx(paragraphs: readonly string[]): Buffer {
    const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('');
    return Buffer.from(
        zipSync({
            '[Content_Types].xml': strToU8(
                '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            ),
            '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
            'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${w}"><w:body>${body}</w:body></w:document>`),
        }),
    );
}

test('upload a DOCX → confirm the cost → facts → confirm one → the interview does not ask it', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Lock Keeper' } })).json()) as { book: { id: string } }).book.id;
    const elementId = ((await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'The lock keeper’s daughter' }] } })).json()) as {
        element: { id: string };
    }).element.id;
    const main = page.getByRole('main');
    const asks = async () => {
        const started = await api.post(`/api/w/${slug}/books/${bookId}/interviews`, { data: { scope: 'ELEMENT', elementId, depth: 2, detail: 3 } });
        expect(started.status()).toBe(201);
        const view = (await started.json()) as { interview: { round: { questions: Array<{ targetsFieldKeys: string[] }> } | null } };
        return (view.interview.round?.questions ?? []).flatMap((q) => q.targetsFieldKeys);
    };
    // Before any source: the want is asked.
    expect(await asks()).toContain('want');

    // The board links to the Sources page; the DOCX goes up through its file input.
    await page.goto(`/w/${slug}/books/${bookId}`);
    await main.locator('#book-sources').click();
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/sources$`));
    await main.locator('#source-upload-input').setInputFiles({
        name: 'draft.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: docx(['Wren wants to cross the river before the spring floods.', 'Wren never learned to swim.']),
    });
    const card = main.getByTestId('source-card').first();
    await expect(card).toContainText('draft.docx', { timeout: 20_000 });
    await expect(card).toContainText('Ready to read');
    await expect(card).toContainText(/Estimated cost .*, at most /);

    // The cost is shown and confirmed before anything is sent; the worker reads it.
    await card.getByTestId('source-read-facts').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('will not spend more than');
    await dialog.getByRole('button', { name: /^Read facts \(at most/ }).click();
    await expect(card).toContainText('Read', { timeout: 90_000 });
    await expect(card.getByText('Read', { exact: true })).toBeVisible({ timeout: 90_000 });

    // The Facts page: the want, quoted from the draft, confirmed.
    await main.locator('#sources-facts-link').click();
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/facts$`));
    const wantCard = () => main.getByTestId('fact-card').filter({ has: page.locator('mark', { hasText: 'Wren wants to cross the river' }) });
    const want = wantCard();
    await expect(want).toBeVisible({ timeout: 20_000 });
    await expect(want.getByTestId('fact-passage').locator('mark')).toHaveText('Wren wants to cross the river before the spring floods.');
    await expect(want).toContainText('Once confirmed, answers Wren: want');
    await want.getByTestId('fact-confirm').click();
    await expect(wantCard()).toHaveCount(0, { timeout: 10_000 });

    // An interview started now does not ask the want.
    const after = await asks();
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain('want');
});
