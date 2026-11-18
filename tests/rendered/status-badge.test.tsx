/**
 * <StatusBadge> — the inline status pill.
 *
 * No inflect-compliance suite exists for this primitive, so this one is new.
 * It holds the behaviour a caller depends on: the label renders, the variant
 * picks its status tone, each variant has its own default icon that `icon`
 * replaces or `icon={null}` removes, a `tooltip` makes the badge a hint
 * trigger, and an `onClick` reaches the handler.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { Feather } from 'lucide-react';
import { StatusBadge, statusBadgeClassName } from '@/components/ui/status-badge';

describe('<StatusBadge>', () => {
    it('renders its label', () => {
        render(<StatusBadge variant="success">Ready</StatusBadge>);
        expect(screen.getByText('Ready')).toBeInTheDocument();
    });

    it.each([
        ['neutral', 'text-content-muted'],
        ['info', 'text-content-info'],
        ['success', 'text-content-success'],
        ['warning', 'text-content-warning'],
        ['error', 'text-content-error'],
    ] as const)('the %s variant wears its status text token', (variant, token) => {
        render(<StatusBadge variant={variant}>Label</StatusBadge>);
        expect(screen.getByText('Label')).toHaveClass(token);
    });

    it('defaults to the quiet (subtle) tone; solid opts into the tinted fill', () => {
        const { rerender } = render(<StatusBadge variant="error">Blocked</StatusBadge>);
        expect(screen.getByText('Blocked')).not.toHaveClass('bg-bg-error');
        rerender(
            <StatusBadge variant="error" tone="solid">
                Blocked
            </StatusBadge>,
        );
        expect(screen.getByText('Blocked')).toHaveClass('bg-bg-error');
        expect(statusBadgeClassName('error')).toContain('bg-bg-error');
    });

    it('renders a default icon, replaces it with `icon`, and drops it with icon={null}', () => {
        const { rerender } = render(<StatusBadge variant="info">Drafting</StatusBadge>);
        const badge = () => screen.getByText('Drafting');
        expect(badge().querySelectorAll('svg')).toHaveLength(1);
        const defaultIcon = badge().querySelector('svg')!.getAttribute('class');

        rerender(
            <StatusBadge variant="info" icon={Feather}>
                Drafting
            </StatusBadge>,
        );
        expect(badge().querySelectorAll('svg')).toHaveLength(1);
        expect(badge().querySelector('svg')!.getAttribute('class')).not.toBe(defaultIcon);

        rerender(
            <StatusBadge variant="info" icon={null}>
                Drafting
            </StatusBadge>,
        );
        expect(badge().querySelector('svg')).toBeNull();
    });

    it('a tooltip makes the badge a help cursor; without one it is not', () => {
        const { rerender } = render(<StatusBadge>Concept</StatusBadge>);
        expect(screen.getByText('Concept')).not.toHaveClass('cursor-help');
        rerender(<StatusBadge tooltip="Not started yet">Concept</StatusBadge>);
        expect(screen.getByText('Concept')).toHaveClass('cursor-help');
    });

    it('fires onClick', async () => {
        const onClick = jest.fn();
        render(<StatusBadge onClick={onClick}>Revising</StatusBadge>);
        await userEvent.setup().click(screen.getByText('Revising'));
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Revising')).toHaveClass('cursor-pointer');
    });
});
