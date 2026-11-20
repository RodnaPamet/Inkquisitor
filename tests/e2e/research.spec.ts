import { expect, test } from '@playwright/test';
import { signUp } from './helpers';
import { STUB_BASE_URL } from './stub-server';

/**
 * The research agent end to end (Phase 2.6, decision D9), on the production
 * build with the STUBBED MODEL (decision D13) and the research worker: the
 * author writes a brief on the Research page and runs it; the background job
 * runs the gather turn through the real server-tool loop — the client, the
 * middleware, the egress tripwire, the ledger — with the stub answering from
 * its fake web (one search, one fetched page, no network); the findings call
 * quotes the page and the fit call proposes the claim for the character's
 * first empty field. The page streams the run's progress, shows the cited
 * finding, and the author accepts the proposal: the element's history then
 * holds a version with source RESEARCH.
 */
test.use({ baseURL: STUB_BASE_URL });

test('brief → run (progress) → cited finding → proposal → accept writes a RESEARCH version', async ({ page }) => {
    test.setTimeout(180_000);
    const slug = await signUp(page);
    const api = page.request;
    const bookId = ((await (await api.post(`/api/w/${slug}/books`, { data: { title: 'The Mews' } })).json()) as { book: { id: string } }).book.id;
    const elementId = ((await (await api.post(`/api/w/${slug}/books/${bookId}/elements`, { data: { kind: 'CHARACTER', name: 'Wren', fields: [{ key: 'role', value: 'Falconer' }] } })).json()) as {
        element: { id: string };
    }).element.id;
    const main = page.getByRole('main');

    // The book's board links to its research.
    await page.goto(`/w/${slug}/books/${bookId}`);
    await main.locator('#book-research').click();
    await expect(page).toHaveURL(new RegExp(`/books/${bookId}/research$`));

    // A brief, scoped to the character.
    await main.locator('#brief-question').fill('How did medieval falconers train hawks?');
    await main.locator('#brief-purpose').fill('My falconer needs believable methods.');
    await main.locator('#brief-scope').click();
    await page.getByRole('option', { name: /Wren/ }).click();
    await page.keyboard.press('Escape');
    await main.locator('#brief-submit').click();
    const brief = main.getByTestId('research-brief').first();
    await expect(brief).toContainText('How did medieval falconers train hawks?', { timeout: 10_000 });
    await expect(brief).toContainText('About: Wren');

    // Run it: the worker picks the job up; the page follows its progress to the end.
    await brief.getByRole('button', { name: 'Run research' }).click();
    await expect(brief.getByTestId('run-summary')).toHaveAttribute('data-outcome', 'OK', { timeout: 90_000 });
    await expect(brief.getByTestId('run-outcome')).toContainText('rests on a passage quoted from its source');

    // The finding, its quote and its source; the proposal, as a diff.
    const finding = brief.getByTestId('research-finding').first();
    await expect(finding).toBeVisible({ timeout: 20_000 });
    await expect(finding.getByTestId('finding-citation').first()).toContainText('Historical records describe');
    await expect(finding.getByRole('link').first()).toHaveAttribute('href', /^https:\/\/research\.stub\.example\//);
    const proposal = brief.getByTestId('research-field-proposal').first();
    await expect(proposal).toBeVisible();
    await proposal.getByRole('button', { name: /^Accept the change to/ }).click();
    await expect(proposal.getByTestId('proposal-status')).toHaveText('Accepted', { timeout: 10_000 });

    // The element's history: a version from research.
    const versions = (await (await api.get(`/api/w/${slug}/books/${bookId}/elements/${elementId}/versions`)).json()) as { versions: Array<{ source: string }> };
    expect(versions.versions[0].source).toBe('RESEARCH');
});
