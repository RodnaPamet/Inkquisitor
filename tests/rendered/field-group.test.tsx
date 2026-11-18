/**
 * <FieldGroup> — a titled cluster of form fields.
 *
 * No inflect-compliance suite exists for it, so this one is new. With a
 * title the group is a named `role="group"` (its heading names it); without
 * one it is an unnamed section with no group role. A hint becomes an info
 * tooltip named after the title, and `columns` sets the grid.
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { FieldGroup } from '@/components/ui/field-group';

describe('<FieldGroup>', () => {
    it('a titled group is a role=group named by its heading', () => {
        render(
            <FieldGroup title="Book details" description="Shown on the cover page.">
                <input aria-label="Title" />
            </FieldGroup>,
        );
        const group = screen.getByRole('group', { name: 'Book details' });
        expect(within(group).getByRole('heading', { level: 3, name: 'Book details' })).toBeInTheDocument();
        expect(within(group).getByText('Shown on the cover page.')).toBeInTheDocument();
        expect(within(group).getByLabelText('Title')).toBeInTheDocument();
    });

    it('without a title it carries no group role', () => {
        const { container } = render(
            <FieldGroup>
                <input aria-label="Title" />
            </FieldGroup>,
        );
        expect(screen.queryByRole('group')).toBeNull();
        expect(container.querySelector('[data-field-group]')).not.toBeNull();
    });

    it('a hint renders an info trigger named after the title', () => {
        render(
            <FieldGroup title="Series" hint="Books in one series share a bible.">
                <input aria-label="Series name" />
            </FieldGroup>,
        );
        expect(screen.getByRole('button', { name: 'More info about Series' })).toBeInTheDocument();
    });

    it('titleAs and columns shape the heading level and the grid', () => {
        const { container } = render(
            <FieldGroup title="Dates" titleAs="h2" columns={2}>
                <input aria-label="Start" />
                <input aria-label="End" />
            </FieldGroup>,
        );
        expect(screen.getByRole('heading', { level: 2, name: 'Dates' })).toBeInTheDocument();
        expect(container.querySelector('.grid')).toHaveClass('sm:grid-cols-2');
    });
});
