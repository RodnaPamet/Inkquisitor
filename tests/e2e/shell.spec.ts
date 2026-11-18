import { expect, test } from '@playwright/test';

/**
 * The application shell and the kitchen sink against a production build
 * (Phase 0.2). The shell renders signed out until 0.3 provides a workspace.
 */

test('the shell renders Books and Settings, signed out, and the sidebar navigates', async ({ page }) => {
    await page.goto('/books');
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Books' })).toBeAttached();
    const nav = page.getByRole('navigation', { name: 'Main navigation' }).first();
    await expect(nav.getByRole('link', { name: 'Books' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Not signed in').first()).toBeVisible();
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText('Sign in to change your settings.')).toBeVisible();
});

test('the theme toggle flips data-theme and the palette follows', async ({ page }) => {
    await page.goto('/books');
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    await page.locator('#top-chrome-theme-toggle').click();
    const after = before === 'dark' ? 'light' : 'dark';
    await expect(html).toHaveAttribute('data-theme', after);
    // Parchment in light, ink in dark: the page background really changes.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe(after === 'light' ? 'rgb(244, 236, 220)' : 'rgb(18, 17, 15)');
});

test('the command palette opens with Ctrl+K and lists the shell destinations', async ({ page }) => {
    await page.goto('/books');
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-command-palette]')).toBeVisible();
    await expect(page.getByTestId('command-palette-nav-nav:settings')).toBeVisible();
});

test('/dev/kitchen-sink is a 404 in a production build', async ({ request }) => {
    const res = await request.get('/dev/kitchen-sink');
    expect(res.status()).toBe(404);
});
