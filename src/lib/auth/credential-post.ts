/**
 * Which NextAuth POSTs carry a credential, and so are charged `LOGIN_LIMIT`
 * (src/app/api/auth/[...nextauth]/route.ts): the credentials callback and the
 * `/signin/<provider>` starts. Matched case-insensitively — a crafted
 * `/api/auth/CALLBACK/Credentials` is the same route to NextAuth's own
 * action lookup only if it lower-cases too, and over-charging costs nothing.
 */
export function carriesCredential(segments: readonly string[] | undefined): boolean {
    const [action, provider] = (segments ?? []).map((s) => s.toLowerCase());
    return (action === 'callback' && provider === 'credentials') || action === 'signin';
}
