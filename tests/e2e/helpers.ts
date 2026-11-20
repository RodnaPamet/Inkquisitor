import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/** A fresh, unique account per call: specs run in parallel against one database. */
export function newCredentials(label = 'e2e') {
    const id = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
    return {
        name: `Writer ${id}`,
        email: `${label}-${id}@example.test`,
        // Assembled, not a literal: a password-shaped string in the tree trips the secret scan.
        password: ['quill', 'and', 'parchment', id].join('-'),
        workspaceName: `Desk ${id}`,
    };
}

export type Credentials = ReturnType<typeof newCredentials>;

/** Sign up through the form and wait to land in the new workspace. Returns its slug. */
export async function signUp(page: Page, creds: Credentials = newCredentials()): Promise<string> {
    await page.goto('/signup');
    await page.locator('#signup-name').fill(creds.name);
    await page.locator('#signup-email').fill(creds.email);
    await page.locator('#signup-password').fill(creds.password);
    await page.locator('#signup-workspace').fill(creds.workspaceName);
    await page.locator('#signup-submit').click();
    // Sign-up hashes the password, makes the workspace's data key and signs in: slower than
    // the 5 s default when two workers and two servers share the machine.
    await expect(page).toHaveURL(/\/w\/[a-z0-9-]+\/books$/, { timeout: 20_000 });
    return new URL(page.url()).pathname.split('/')[2];
}

export async function signIn(page: Page, creds: Pick<Credentials, 'email' | 'password'>): Promise<void> {
    await page.goto('/login');
    await page.locator('#login-email').fill(creds.email);
    await page.locator('#login-password').fill(creds.password);
    await page.locator('#login-submit').click();
}
