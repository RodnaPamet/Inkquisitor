import type { NextRequest } from 'next/server';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

/**
 * The origin this deployment is reachable at from OUTSIDE, for any URL handed
 * to somebody else (an email link, a share link, a redirect target).
 *
 * `APP_URL` is authoritative when set: it is the operator's statement of where
 * the deployment lives, and the one source a reverse proxy cannot distort.
 * The request origin is a development fallback only: behind a proxy it is the
 * app's own bind address (inflect-compliance shipped `https://0.0.0.0:3000/…`
 * links that way), and `X-Forwarded-Host` is attacker-controlled on any
 * request that reaches the app directly.
 *
 * ESLint `local/no-request-derived-public-url` refuses `nextUrl.host` /
 * `origin` / `hostname` in a route handler; this helper is its exemption.
 *
 * Lifted from inflect-compliance's `src/lib/http/public-base-url.ts`.
 */
export function publicBaseUrl(req: Pick<NextRequest, 'nextUrl'>): string {
    const configured = env.APP_URL?.trim();
    if (configured) {
        // Trailing slashes would double up against the paths callers append.
        return configured.replace(/\/+$/, '');
    }

    if (env.NODE_ENV === 'production') {
        // Not fatal — refusing to serve the page would be a worse failure than
        // showing a host the operator can recognise as wrong. But it is never
        // correct in production, so it should be findable in the logs rather
        // than only in a support ticket about a webhook that never fired.
        logger.warn(
            'APP_URL is unset in production; falling back to the request origin ' +
                'for an externally-published URL. Behind a proxy this yields the ' +
                "app's internal bind address, which is not reachable.",
            { component: 'http', origin: req.nextUrl.origin },
        );
    }

    return req.nextUrl.origin;
}
