import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

/**
 * The application shell against a production build, inside a real workspace
 * (Phase 0.3: every page lives under /w/<slug>/).
 */

test('the shell renders Books and Settings for the workspace, and the sidebar navigates', async ({ page }) => {
    const slug = await signUp(page);
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Books' })).toBeAttached();
    const nav = page.getByRole('navigation', { name: 'Main navigation' }).first();
    await expect(nav.getByRole('link', { name: 'Books' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Not signed in')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/settings$`));
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('the theme toggle flips data-theme and the palette follows', async ({ page }) => {
    await signUp(page);
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    // Inside a workspace the toggle lives in the user menu.
    await page.getByTestId('top-chrome-user-menu').click();
    await page.locator('#user-menu-theme-toggle').click();
    const after = before === 'dark' ? 'light' : 'dark';
    await expect(html).toHaveAttribute('data-theme', after);
    // Parchment in light, ink in dark: the page background really changes.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(after === 'light' ? 'rgb(244, 236, 220)' : 'rgb(18, 17, 15)');
});

test('the command palette opens with Ctrl+K and lists the workspace destinations', async ({ page }) => {
    const slug = await signUp(page);
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-command-palette]')).toBeVisible();
    const settings = page.getByTestId('command-palette-nav-nav:settings');
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute('data-href', `/w/${slug}/settings`);
});

test('/dev/kitchen-sink is a 404 in a production build', async ({ request }) => {
    const res = await request.get('/dev/kitchen-sink');
    expect(res.status()).toBe(404);
});
