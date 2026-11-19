/**
 * The `UserSession.sessionId` the current request's JWT carries — "this
 * browser" — so "sign out other sessions" can keep it. Read from the cookie
 * with next-auth's `getToken`: from the request in a route handler, from
 * `next/headers` in a server component.
 */
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { authSecret } from './auth-secret';

export async function currentSessionId(req?: NextRequest): Promise<string | null> {
    try {
        let source: Parameters<typeof getToken>[0]['req'];
        if (req) {
            source = req;
        } else {
            const { cookies, headers } = await import('next/headers');
            const jar = await cookies();
            const hdrs = await headers();
            source = {
                cookies: Object.fromEntries(jar.getAll().map((c) => [c.name, c.value])),
                headers: Object.fromEntries(hdrs.entries()),
            } as unknown as NextRequest;
        }
        const token = await getToken({ req: source, secret: authSecret() });
        const id = token?.userSessionId;
        return typeof id === 'string' && id !== '' ? id : null;
    } catch {
        return null;
    }
}
