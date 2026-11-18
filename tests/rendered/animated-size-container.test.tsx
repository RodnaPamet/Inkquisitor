/**
 * <AnimatedSizeContainer> — animates its box to its content's size.
 *
 * No inflect-compliance suite exists for it, so this one is new. jsdom has
 * no layout, so the animation itself cannot be measured; what can regress is
 * the structure: the outer box clips (`overflow-hidden`), the inner box sizes
 * to its content on the animated axes only, and children render and update.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { AnimatedSizeContainer } from '@/components/ui/animated-size-container';

function Expander() {
    const [open, setOpen] = React.useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen((o) => !o)}>
                Toggle
            </button>
            <AnimatedSizeContainer height data-testid="asc">
                <p>Logline</p>
                {open && <p>The full synopsis.</p>}
            </AnimatedSizeContainer>
        </>
    );
}

describe('<AnimatedSizeContainer>', () => {
    it('clips on the outside and sizes the inside to content on the animated axis', () => {
        render(<Expander />);
        const outer = screen.getByTestId('asc');
        expect(outer).toHaveClass('overflow-hidden');
        const inner = outer.firstElementChild!;
        expect(inner).toHaveClass('h-max');
        expect(inner).not.toHaveClass('w-max');
    });

    it('renders and updates its children', () => {
        render(<Expander />);
        expect(screen.queryByText('The full synopsis.')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
        expect(screen.getByText('The full synopsis.')).toBeInTheDocument();
    });
});
