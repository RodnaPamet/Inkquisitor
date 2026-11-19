import { expect, test } from '@playwright/test';

test('home page shows the product name, styled by Tailwind, and the ways in', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('main').getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Inkquisitor');
    // Each value differs from the browser's default h1 (2em = 32px, letter
    // spacing `normal`), so if Tailwind's CSS did not reach the page both
    // assertions fail. `text-5xl` is 3rem (48px); `tracking-tight` is
    // -0.025em, -1.2px at 48px. (`font-bold` is not asserted: a default h1
    // is already 700, so it would pass with no CSS at all.)
    await expect(heading).toHaveCSS('font-size', '48px');
    await expect(heading).toHaveCSS('letter-spacing', '-1.2px');
    await expect(page).toHaveTitle('Inkquisitor');
    await expect(page.locator('#home-sign-in')).toHaveAttribute('href', '/login');
    await expect(page.locator('#home-sign-up')).toHaveAttribute('href', '/signup');
});

test('/api/health answers ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
});
