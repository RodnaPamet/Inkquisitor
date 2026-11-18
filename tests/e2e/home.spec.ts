import { expect, test } from '@playwright/test';

test('home page shows the product name, styled by Tailwind', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('main').getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Inkquisitor');
    // `text-5xl` is 3rem (48px) and `font-bold` is 700: if Tailwind's CSS did
    // not reach the page the heading would fall back to the browser's h1.
    await expect(heading).toHaveCSS('font-size', '48px');
    await expect(heading).toHaveCSS('font-weight', '700');
    await expect(page).toHaveTitle('Inkquisitor');
});

test('/api/health answers ok', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
});
