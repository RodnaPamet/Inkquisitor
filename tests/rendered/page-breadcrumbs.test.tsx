/**
 * <PageBreadcrumbs> — breadcrumbs for a page that does not use PageHeader.
 *
 * No inflect-compliance suite exists for it, so this one is new. It does two
 * things: it pushes its trail into the shell's breadcrumbs store (which the
 * top chrome renders on desktop), and it renders the same trail inline for
 * small screens only (`md:hidden`).
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BreadcrumbsProvider, useCurrentBreadcrumbs } from '@/components/layout/breadcrumbs-store';

const TRAIL = [{ label: 'Books', href: '/books' }, { label: 'Salt and Iron' }];

function ChromeProbe() {
    const crumbs = useCurrentBreadcrumbs();
    return <output data-testid="chrome">{crumbs.map((c) => c.label).join(' / ')}</output>;
}

describe('<PageBreadcrumbs>', () => {
    it('renders the trail inline, for small screens only', () => {
        render(<PageBreadcrumbs items={TRAIL} data-testid="crumbs" />);
        const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
        expect(within(nav).getByRole('link', { name: 'Books' })).toHaveAttribute('href', '/books');
        expect(nav.closest('.md\\:hidden')).not.toBeNull();
    });

    it('pushes the trail into the shell store the top chrome reads', () => {
        render(
            <BreadcrumbsProvider>
                <ChromeProbe />
                <PageBreadcrumbs items={TRAIL} />
            </BreadcrumbsProvider>,
        );
        expect(screen.getByTestId('chrome')).toHaveTextContent('Books / Salt and Iron');
    });
});
