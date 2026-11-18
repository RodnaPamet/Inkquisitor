/**
 * `local/no-request-derived-public-url` — RuleTester.
 *
 * inflect-compliance carried no RuleTester for this rule (only a guard that
 * it is wired); this one is new. The `valid` half holds the rule's scope:
 * files outside `src/app/api/`, the helper itself, and reads that are not a
 * host (`nextUrl.pathname`, `searchParams`). The `invalid` half is each shape
 * the rule's header claims to cover, including the destructuring form its
 * first version missed.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js.
const rule = require('../rules/no-request-derived-public-url');

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

const ROUTE = '/repo/src/app/api/share/route.ts';

describe('local/no-request-derived-public-url', () => {
    ruleTester.run('no-request-derived-public-url', rule, {
        valid: [
            {
                name: 'the helper, in a route',
                filename: ROUTE,
                code: 'const base = publicBaseUrl(req); const link = `${base}/share/${id}`;',
            },
            {
                name: 'the path and the query are not the host',
                filename: ROUTE,
                code: 'const p = req.nextUrl.pathname; const q = req.nextUrl.searchParams.get("x");',
            },
            {
                name: 'middleware may read the host for routing decisions',
                filename: '/repo/src/middleware.ts',
                code: 'const h = req.nextUrl.host;',
            },
            {
                name: 'the helper implements the fallback, so it reads the origin',
                filename: '/repo/src/app/api/lib/http/public-base-url.ts',
                code: 'export const f = (req) => req.nextUrl.origin;',
            },
            {
                name: 'a host read off something that is not nextUrl',
                filename: ROUTE,
                code: 'const h = new URL(env.APP_URL).host;',
            },
        ],
        invalid: [
            {
                name: 'the template literal that shipped 0.0.0.0:3000 links',
                filename: ROUTE,
                code: 'const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;',
                errors: [{ messageId: 'requestDerived', data: { prop: 'host' } }],
            },
            {
                name: 'the origin',
                filename: ROUTE,
                code: 'const link = req.nextUrl.origin + "/reset?token=" + t;',
                errors: [{ messageId: 'requestDerived', data: { prop: 'origin' } }],
            },
            {
                name: 'the hostname',
                filename: ROUTE,
                code: 'const h = request.nextUrl.hostname;',
                errors: [{ messageId: 'requestDerived', data: { prop: 'hostname' } }],
            },
            {
                name: 'destructured, the form a regex misses',
                filename: ROUTE,
                code: 'const { host, pathname } = req.nextUrl;',
                errors: [{ messageId: 'requestDerived', data: { prop: 'host' } }],
            },
        ],
    });
});
