import { expect, test } from '@playwright/test';
import { newCredentials, signIn, signUp } from './helpers';

/**
 * Identity against the production build (Phase 0.3): sign up → land in the
 * new, empty workspace → sign out → sign in → land back in it. And the gates:
 * a signed-out visitor is sent to sign in, a member of one workspace cannot
 * open another, a wrong password says nothing about whether the email exists.
 */

test('sign up, land in the workspace, sign out, sign in again', async ({ page }) => {
    const creds = newCredentials('flow');
    const slug = await signUp(page, creds);

    // The empty workspace, inside the shell, naming the person and the workspace.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Books' })).toBeVisible();
    await expect(main.getByText('No books yet.')).toBeVisible();
    const identity = page.getByTestId('sidebar-identity').first();
    await expect(identity).toContainText(creds.name);
    await expect(identity).toContainText(creds.workspaceName);
    await expect(identity).toContainText('Owner');

    // Sign out from the sidebar: back to sign-in, and the workspace is closed.
    await page.getByTestId('nav-logout').first().click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`/w/${slug}/books`);
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);

    // Sign in from there: straight back to where the browser was going.
    await page.locator('#login-email').fill(creds.email);
    await page.locator('#login-password').fill(creds.password);
    await page.locator('#login-submit').click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books$`));

    // And `/` sends a signed-in person to their workspace.
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/books$`));
});

test('a wrong password is refused without saying whether the email exists', async ({ page }) => {
    const creds = newCredentials('wrong');
    await signUp(page, creds);
    await page.getByTestId('nav-logout').first().click();
    await expect(page).toHaveURL(/\/login/);

    await signIn(page, { email: creds.email, password: `${creds.password}-not` });
    await expect(page.locator('#login-error')).toHaveText('That email and password do not match an account.');
    await signIn(page, { email: `nobody-${creds.email}`, password: creds.password });
    await expect(page.locator('#login-error')).toHaveText('That email and password do not match an account.');
});

test('signing up twice with one email is refused', async ({ page, browser }) => {
    const creds = newCredentials('twice');
    await signUp(page, creds);
    const other = await browser.newPage();
    await other.goto('/signup');
    await other.locator('#signup-email').fill(creds.email);
    await other.locator('#signup-password').fill(creds.password);
    await other.locator('#signup-submit').click();
    await expect(other.locator('#signup-error')).toHaveText('An account with this email already exists. Sign in instead.');
    await other.close();
});

test("a member of one workspace cannot open another's", async ({ page, browser }) => {
    const theirs = await (async () => {
        const p = await browser.newPage();
        const slug = await signUp(p, newCredentials('owner'));
        await p.close();
        return slug;
    })();
    await signUp(page, newCredentials('intruder'));

    await page.goto(`/w/${theirs}/books`);
    await expect(page).toHaveURL(/\/no-workspace$/);
    await expect(page.getByRole('heading', { level: 1, name: 'No workspace here' })).toBeVisible();

    const api = await page.request.get(`/api/w/${theirs}/members`);
    expect(api.status()).toBe(403);
});

test('a signed-out visitor is sent to sign in, and the workspace API answers 401', async ({ page }) => {
    await page.goto('/w/somebody/books');
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fw%2Fsomebody%2Fbooks$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    // The Google button appears only when Google is configured; the E2E server configures none.
    await expect(page.locator('#google-sign-in')).toHaveCount(0);
    const api = await page.request.get('/api/w/somebody/members');
    expect(api.status()).toBe(401);
});

test('settings lists this session', async ({ page }) => {
    const slug = await signUp(page);
    await page.goto(`/w/${slug}/settings`);
    const sessions = page.locator('#settings-sessions');
    await expect(sessions.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await expect(sessions).toContainText('This browser');
});
