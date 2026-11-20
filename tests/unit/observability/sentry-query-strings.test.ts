/**
 * No query string reaches Sentry (issue #29 item 1; roadmap rule 4).
 *
 * The relation picker's server search sends fragments of element names as
 * `q`; Sentry's beforeSend kept every parameter but a short list of
 * credentials, so an error on that route carried author text into the report.
 * Every query string and fragment is now cut, from the request's URL and from
 * each breadcrumb's URL members and URL-shaped message.
 */
import type { ErrorEvent } from '@sentry/nextjs';
import { FILTERED_QUERY, redactUrl, scrubEvent } from '@/lib/observability/sentry';

const NAME_FRAGMENT = 'Wennaway Marsh-Hollow';

describe('redactUrl', () => {
    it.each([
        ['http://app.test/api/w/acme/books/b1/elements?q=Wennaway', `http://app.test/api/w/acme/books/b1/elements?${FILTERED_QUERY}`],
        ['/api/w/acme/books/b1/elements?kind=CHARACTER&q=Wennaway', `/api/w/acme/books/b1/elements?${FILTERED_QUERY}`],
        ['/w/acme/books/b1#Wennaway', '/w/acme/books/b1'],
        ['/w/acme/books/b1', '/w/acme/books/b1'],
        ['/w/acme/books/b1?', `/w/acme/books/b1?${FILTERED_QUERY}`],
    ])('%s → %s', (input, expected) => {
        expect(redactUrl(input)).toBe(expected);
    });
});

it('cuts the query from the request, every breadcrumb URL member and a URL-shaped breadcrumb message', () => {
    const q = encodeURIComponent(NAME_FRAGMENT);
    const event = {
        request: { url: `https://app.test/api/w/acme/books/b1/elements?q=${q}`, query_string: `q=${q}` },
        breadcrumbs: [
            { category: 'fetch', data: { url: `/api/w/acme/books/b1/elements?q=${q}`, method: 'GET' } },
            { category: 'navigation', data: { from: `/w/acme/books/b1?q=${q}`, to: `/w/acme/books/b1/elements?after=${q}` } },
            { category: 'navigation', message: `/w/acme/books/b1?q=${q}` },
        ],
    } as unknown as ErrorEvent;
    const out = JSON.stringify(scrubEvent(event));
    expect(out).not.toContain(q);
    expect(out).not.toContain('Wennaway');
    expect(out).toContain(`/api/w/acme/books/b1/elements?${FILTERED_QUERY}`);
});
