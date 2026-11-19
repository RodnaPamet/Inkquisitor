import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The bible API against the production build (Phase 1.1), with a real session
 * cookie: create a book and an element, save fields, relate two elements,
 * read the history and restore from it. Another author's session cannot see
 * any of it. (No UI yet: that is 1.2.)
 */

test('an author keeps a versioned bible through the API, and nobody else can read it', async ({ page, browser }) => {
    const slug = await signUp(page);
    const api = page.request;
    const base = `/api/w/${slug}/books`;

    const book = await api.post(base, { data: { title: 'The Salt Roads', logline: 'A ferrywoman crosses a drowned country.' } });
    expect(book.status()).toBe(201);
    const bookId = (await book.json()).book.id as string;

    const character = await api.post(`${base}/${bookId}/elements`, {
        data: { kind: 'CHARACTER', name: 'Mara', fields: [{ key: 'role', value: 'Protagonist' }] },
    });
    expect(character.status()).toBe(201);
    const elementId = (await character.json()).element.id as string;
    const faction = await api.post(`${base}/${bookId}/elements`, { data: { kind: 'FACTION', name: 'The Tidewardens' } });
    const factionId = (await faction.json()).element.id as string;

    const saved = await api.put(`${base}/${bookId}/elements/${elementId}/fields`, {
        data: { fields: [{ key: 'want', value: 'To reach <b>the far shore</b><script>x()</script>' }, { key: 'agency', value: 4 }], baseVersion: 1 },
    });
    expect(saved.status()).toBe(200);
    const after = (await saved.json()).element;
    expect(after.versionNumber).toBe(2);
    expect(after.fields.find((f: { key: string }) => f.key === 'want').value).toBe('To reach the far shore');

    const rel = await api.post(`${base}/${bookId}/relations`, { data: { fromElementId: elementId, toElementId: factionId, type: 'member_of' } });
    expect(rel.status()).toBe(201);
    const fromFaction = (await (await api.get(`${base}/${bookId}/elements/${factionId}`)).json()).element;
    expect(fromFaction.relations[0]).toMatchObject({ direction: 'incoming', label: 'has member' });

    const history = (await (await api.get(`${base}/${bookId}/elements/${elementId}/versions`)).json()).versions;
    expect(history.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    const restored = await api.post(`${base}/${bookId}/elements/${elementId}/versions/1/restore`, { data: { baseVersion: 2 } });
    expect(restored.status()).toBe(201);
    expect((await restored.json()).restore.version.versionNumber).toBe(3);

    // A second author, signed in in a context of their own, gets the 404 a missing workspace gets.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signUp(otherPage);
    for (const path of [base, `${base}/${bookId}`, `${base}/${bookId}/elements/${elementId}`]) {
        expect([403, 404]).toContain((await otherPage.request.get(path)).status());
    }
    await other.close();
});

test('the production server refuses an oversized body 413 and a NUL-bearing title cleanly', async ({ page }) => {
    const slug = await signUp(page);
    const base = `/api/w/${slug}/books`;
    const huge = await page.request.post(base, {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ title: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(huge.status()).toBe(413);
    expect((await huge.json()).error.details).toMatchObject({ reason: 'BODY_TOO_LARGE' });

    const nul = await page.request.post(base, { data: { title: 'Salt&#0;\u0000 Roads', genre: '&#0;' } });
    expect(nul.status()).toBe(201);
    expect((await nul.json()).book).toMatchObject({ title: 'Salt Roads', genre: null });
});
