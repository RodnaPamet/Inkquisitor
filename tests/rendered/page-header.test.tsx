/**
 * <PageHeader> — the one header every page and shell renders.
 *
 * No inflect-compliance suite exists for it on its own (inflect covers it
 * through the entity shells' suites, ported here too), so this one is new. It
 * holds each slot: the h1 title, `titleHidden` keeping the h1 as a landmark
 * but visually hidden, the eyebrow, description, meta, back link, in-page
 * breadcrumbs, the actions cluster, and the title adornment sitting BESIDE
 * the heading rather than inside its accessible name.
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';

describe('<PageHeader>', () => {
    it('renders the title as the page h1', () => {
        render(<PageHeader title="Books" />);
        const h1 = screen.getByRole('heading', { level: 1, name: 'Books' });
        expect(h1).not.toHaveClass('sr-only');
    });

    it('titleHidden keeps the h1 for assistive technology but hides it visually', () => {
        render(<PageHeader title="Books" titleHidden />);
        expect(screen.getByRole('heading', { level: 1, name: 'Books' })).toHaveClass('sr-only');
    });

    it('renders eyebrow, description and meta only when given', () => {
        const { rerender } = render(<PageHeader title="Books" />);
        expect(screen.queryByTestId('page-header-eyebrow')).toBeNull();
        expect(screen.queryByTestId('page-header-description')).toBeNull();
        expect(screen.queryByTestId('page-header-meta')).toBeNull();

        rerender(<PageHeader title="Books" eyebrow="Library" description="Every book." meta={<span>3 books</span>} />);
        expect(screen.getByTestId('page-header-eyebrow')).toHaveTextContent('Library');
        expect(screen.getByTestId('page-header-description')).toHaveTextContent('Every book.');
        expect(screen.getByTestId('page-header-meta')).toHaveTextContent('3 books');
    });

    it('renders a back link to its href', () => {
        render(<PageHeader title="Salt and Iron" back={{ href: '/books', label: 'Books' }} />);
        const back = screen.getByTestId('page-header-back');
        expect(back).toHaveAttribute('href', '/books');
        expect(back).toHaveTextContent('Books');
    });

    it('renders in-page breadcrumbs when given', () => {
        render(<PageHeader title="Salt and Iron" breadcrumbs={[{ label: 'Books', href: '/books' }, { label: 'Salt and Iron' }]} />);
        const crumbs = screen.getByTestId('page-header-breadcrumbs');
        expect(within(crumbs).getByRole('link', { name: 'Books' })).toHaveAttribute('href', '/books');
    });

    it('puts actions in the actions cluster', () => {
        render(<PageHeader title="Books" actions={<button type="button">Book</button>} />);
        expect(within(screen.getByTestId('page-header-actions')).getByRole('button', { name: 'Book' })).toBeInTheDocument();
    });

    it('a title adornment sits beside the heading, outside its accessible name', () => {
        render(<PageHeader title="Books" titleAdornment={<button type="button" aria-label="Help" />} />);
        expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Books');
        expect(within(screen.getByTestId('page-header-title-row')).getByRole('button', { name: 'Help' })).toBeInTheDocument();
    });
});
