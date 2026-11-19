import { expect, test, type Browser, type Page } from '@playwright/test';
import { newCredentials, signIn, signUp } from './helpers';

/**
 * Two writers on one element (Phase 1.H, item 2), in two browser contexts —
 * two sessions, two pages, one element. The second save, based on a version
 * the first has overtaken, is refused; the page says so and offers the
 * choice, and never overwrites the other writer's save silently: "Keep my
 * edits" saves over it knowingly, "Reload their version" shows theirs.
 */

const saved = (page: Page) => expect(page.locator('[data-testid="save-status"]')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

async function twoWriters(browser: Browser) {
    const creds = newCredentials('concurrent');
    const a = await (await browser.newContext()).newPage();
    const slug = await signUp(a, creds);
    const book = await a.request.post(`/api/w/${slug}/books`, { data: { title: 'Two writers' } });
    const bookId = ((await book.json()) as { book: { id: string } }).book.id;
    const el = await a.request.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Mara' } });
    const elementId = ((await el.json()) as { element: { id: string } }).element.id;
    const url = `/w/${slug}/books/${bookId}/elements/${elementId}`;
    const b = await (await browser.newContext()).newPage();
    await signIn(b, creds);
    await expect(b).toHaveURL(/\/w\//);
    await a.goto(url);
    await b.goto(url);
    return { a, b, url, api: `/api/w/${slug}/books/${bookId}/elements/${elementId}` };
}

test('the second writer is told, keeps their edits on purpose, and the first sees them', async ({ browser }) => {
    test.setTimeout(90_000);
    const { a, b, api } = await twoWriters(browser);
    const roleA = a.getByRole('main').getByTestId('field-input-role');
    const roleB = b.getByRole('main').getByTestId('field-input-role');

    await roleA.fill('Ferrywoman');
    await saved(a);
    // B's page still holds version 1: its save is refused, not applied.
    await roleB.fill('Smuggler');
    const notice = b.getByTestId('version-conflict');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText('It is now at version 2');
    expect(((await (await a.request.get(api)).json()) as { element: { fields: Array<{ key: string; value: unknown }> } }).element.fields.find((f) => f.key === 'role')?.value).toBe(
        'Ferrywoman',
    );

    await b.locator('#conflict-keep').click();
    await saved(b);
    await expect(notice).toBeHidden();
    await a.reload();
    await expect(roleA).toHaveValue('Smuggler');
});

test('"Reload their version" drops the refused edit and shows the other writer’s save', async ({ browser }) => {
    test.setTimeout(90_000);
    const { a, b, api } = await twoWriters(browser);
    const roleA = a.getByRole('main').getByTestId('field-input-role');
    const roleB = b.getByRole('main').getByTestId('field-input-role');

    await roleA.fill('Pilot');
    await saved(a);
    await roleB.fill('Stowaway');
    await expect(b.getByTestId('version-conflict')).toBeVisible({ timeout: 10_000 });
    await b.locator('#conflict-reload').click();
    await expect(b.getByTestId('version-conflict')).toBeHidden();
    await expect(roleB).toHaveValue('Pilot');
    // B edits again, on A's version: saved, no conflict.
    await roleB.fill('Pilot captain');
    await saved(b);
    const body = (await (await a.request.get(api)).json()) as { element: { versionNumber: number; fields: Array<{ key: string; value: unknown }> } };
    expect(body.element.fields.find((f) => f.key === 'role')?.value).toBe('Pilot captain');
    expect(body.element.versionNumber).toBe(3);
});

test('leaving by a link while a conflict holds edits asks first: staying keeps them, leaving drops them', async ({ browser }) => {
    test.setTimeout(90_000);
    const { a, b, url } = await twoWriters(browser);
    const roleA = a.getByRole('main').getByTestId('field-input-role');
    const roleB = b.getByRole('main').getByTestId('field-input-role');

    await roleA.fill('Pilot');
    await saved(a);
    await roleB.fill('Stowaway');
    await expect(b.getByTestId('version-conflict')).toBeVisible({ timeout: 10_000 });

    const books = b.getByRole('link', { name: 'Books', exact: true }).first();
    const asked: string[] = [];
    b.once('dialog', (d) => {
        asked.push(d.message());
        void d.dismiss();
    });
    await books.click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain('your edits are not saved');
    // Stayed: the same page, the held edit, the notice.
    expect(new URL(b.url()).pathname).toBe(url);
    await expect(roleB).toHaveValue('Stowaway');
    await expect(b.getByTestId('version-conflict')).toBeVisible();

    b.once('dialog', (d) => void d.accept());
    await books.click();
    await expect(b).toHaveURL(/\/books$/);
    // Left on purpose: nothing was sent over A's save.
    const api = url.replace('/w/', '/api/w/');
    const body = (await (await a.request.get(api)).json()) as { element: { versionNumber: number; fields: Array<{ key: string; value: unknown }> } };
    expect(body.element.fields.find((f) => f.key === 'role')?.value).toBe('Pilot');
    expect(body.element.versionNumber).toBe(2);
});
