/**
 * The message key for an error a sign-in reports — NextAuth's `?error=` on
 * the sign-in page, or `signIn(…).error`. Client-safe. Every credentials
 * failure but the lockout is the generic `CredentialsSignin`, so the page
 * never says whether the email exists.
 */
export type SignInErrorKey = 'invalid' | 'rateLimited' | 'googleUnverified' | 'generic';

export function signInErrorKey(error: string | null | undefined): SignInErrorKey | null {
    if (!error) return null;
    switch (error) {
        case 'CredentialsSignin':
            return 'invalid';
        case 'RateLimited':
            return 'rateLimited';
        case 'GoogleEmailUnverified':
            return 'googleUnverified';
        default:
            return 'generic';
    }
}
