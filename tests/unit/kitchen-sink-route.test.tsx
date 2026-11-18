/**
 * `/dev/kitchen-sink` answers 404 in a production build and renders the
 * sink otherwise, handing it the page's search params as the filter
 * toolbar's initial (server) state.
 *
 * The page reads `env.NODE_ENV` (the mock in tests/mocks/env.ts answers from
 * process.env), so each case sets it. The sink itself is stubbed: this suite
 * is about the route's gate, and the sink is mounted for real by
 * tests/rendered/kitchen-sink.test.tsx.
 */
jest.mock('@/components/dev/KitchenSink', () => ({ KitchenSink: () => null }));

import { isValidElement } from 'react';
import KitchenSinkPage from '@/app/(app)/dev/kitchen-sink/page';
import { KitchenSink } from '@/components/dev/KitchenSink';

const ORIGINAL = process.env.NODE_ENV;
function setNodeEnv(value: string | undefined) {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

afterEach(() => setNodeEnv(ORIGINAL));

const page = (params: Record<string, string | string[] | undefined> = {}) =>
    KitchenSinkPage({ searchParams: Promise.resolve(params) });

describe('/dev/kitchen-sink route', () => {
    it('is a 404 when NODE_ENV=production', async () => {
        setNodeEnv('production');
        let thrown: unknown;
        try {
            await page();
        } catch (err) {
            thrown = err;
        }
        // `notFound()` throws Next's HTTP-fallback error, whose digest
        // carries the status; anything else (a crash, a render) is wrong.
        expect((thrown as { digest?: string } | undefined)?.digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
    });

    it.each(['development', 'test'])('renders the kitchen sink when NODE_ENV=%s', async (nodeEnv) => {
        setNodeEnv(nodeEnv);
        const element = await page();
        expect(isValidElement(element)).toBe(true);
        expect(element.type).toBe(KitchenSink);
    });

    it('hands the search params to the sink as its initial filters, multi-values comma-joined', async () => {
        // The filter toolbar's server render reads these; without them a
        // reload of a filtered URL hydrates with a pill the server HTML lacked.
        setNodeEnv('development');
        const element = await page({ stage: ['Drafting', 'Revising'], q: 'lantern', empty: undefined });
        expect(element.props).toEqual({ initialFilters: { stage: 'Drafting,Revising', q: 'lantern' } });
    });

    it('is kept out of search indexes', async () => {
        const { metadata } = await import('@/app/(app)/dev/kitchen-sink/page');
        expect(metadata.robots).toEqual({ index: false });
    });
});
