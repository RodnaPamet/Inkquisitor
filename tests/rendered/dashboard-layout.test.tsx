/**
 * <DashboardLayout> — the dashboard composition shell.
 *
 * No inflect-compliance suite exists for it on its own, so this one is new.
 * The shell carries layout only: its header is a `<PageHeader>` (so the page
 * has exactly one h1, with the header's slots), its body is the children in
 * order, and the outer wrapper takes the caller's className and testid.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';

describe('<DashboardLayout>', () => {
    it('renders the header through PageHeader, then the body in order', () => {
        render(
            <DashboardLayout
                header={{ title: 'Readiness', description: 'How close each book is.', actions: <button type="button">Refresh</button> }}
                data-testid="dash"
            >
                <section>First card</section>
                <section>Second card</section>
            </DashboardLayout>,
        );
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByRole('heading', { level: 1, name: 'Readiness' })).toBeInTheDocument();
        expect(screen.getByTestId('page-header-description')).toHaveTextContent('How close each book is.');
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

        const root = screen.getByTestId('dash');
        const text = root.textContent ?? '';
        expect(text.indexOf('Readiness')).toBeLessThan(text.indexOf('First card'));
        expect(text.indexOf('First card')).toBeLessThan(text.indexOf('Second card'));
    });

    it('marks its wrapper and merges the caller className', () => {
        render(
            <DashboardLayout header={{ title: 'Readiness' }} className="pb-page" data-testid="dash">
                <p>Body</p>
            </DashboardLayout>,
        );
        const root = screen.getByTestId('dash');
        expect(root).toHaveAttribute('data-dashboard-layout');
        expect(root).toHaveClass('pb-page', 'space-y-section');
    });
});
