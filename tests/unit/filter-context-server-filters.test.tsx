/**
 * On the server, `useFilterContext` builds its state from `serverFilters`.
 *
 * The unit project runs with no `window`, as a server render does. A page
 * that passes its search params as `serverFilters` gets, from
 * `renderToString`, the same filter state the client reads from
 * `window.location.search` on its first render, so the two renders agree and
 * hydration does not fail. Without `serverFilters` the server state is empty
 * whatever the URL says. tests/rendered/kitchen-sink-filter-hydration.test.tsx
 * holds the client half for the kitchen sink.
 */
jest.mock('next/navigation', () => ({
    useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
    usePathname: () => '/dev/kitchen-sink',
}));

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useFilterContext } from '@/components/ui/filter/filter-context';

function Harness({ serverFilters }: { serverFilters?: Record<string, string> }) {
    const ctx = useFilterContext([], ['stage', 'genre'], { serverFilters });
    return createElement('output', null, JSON.stringify({ state: ctx.state, search: ctx.search }));
}

function serverRender(serverFilters?: Record<string, string>) {
    expect(typeof window).toBe('undefined');
    const html = renderToString(createElement(Harness, { serverFilters }));
    return JSON.parse(/<output>(.*)<\/output>/.exec(html)![1].replace(/&quot;/g, '"'));
}

describe('useFilterContext on the server', () => {
    it('reads the filter keys and the search from serverFilters, splitting multi-values', () => {
        expect(serverRender({ stage: 'Drafting,Revising', q: 'lantern', other: 'x' })).toEqual({
            state: { stage: ['Drafting', 'Revising'] },
            search: 'lantern',
        });
    });

    it('is empty without serverFilters', () => {
        expect(serverRender()).toEqual({ state: {}, search: '' });
    });
});
