/**
 * <PageActions> — the right-aligned action cluster of a page header.
 *
 * No inflect-compliance suite exists for it, so this one is new. It renders
 * its children in order inside one cluster whose geometry keeps the primary
 * (last) action at the right edge when the row wraps, and it takes a testid.
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { PageActions } from '@/components/layout/PageActions';

describe('<PageActions>', () => {
    it('renders its actions in order in one right-aligned cluster', () => {
        render(
            <PageActions>
                <button type="button">Export</button>
                <button type="button">Book</button>
            </PageActions>,
        );
        const cluster = screen.getByTestId('page-actions');
        expect(within(cluster).getAllByRole('button').map((b) => b.textContent)).toEqual(['Export', 'Book']);
        expect(cluster).toHaveClass('justify-end', 'flex-wrap-reverse');
    });

    it('takes a testid and extra classes', () => {
        render(
            <PageActions data-testid="book-actions" className="mt-2">
                <button type="button">Book</button>
            </PageActions>,
        );
        expect(screen.getByTestId('book-actions')).toHaveClass('mt-2');
    });
});
