/**
 * <ThemeToggle> — the light/dark switch.
 *
 * The first three cases are ported from inflect-compliance's
 * tests/rendered/tooltip-migration.test.tsx (its ThemeToggle block; the rest
 * of that file covers inflect admin pages and was not carried). The last two
 * are new: the click flips `html[data-theme]`, the label and the pressed
 * state together, and a custom `id` reaches the button.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';

function renderToggle(id?: string) {
    return render(
        <TooltipProvider delayDuration={0}>
            <ThemeProvider>
                <ThemeToggle id={id} />
            </ThemeProvider>
        </TooltipProvider>,
    );
}

beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.cookie = 'inkquisitor_theme=; path=/; max-age=0';
    window.localStorage.clear();
});

describe('<ThemeToggle>', () => {
    it('does not forward `title` to the HTML button', () => {
        renderToggle();
        expect(screen.getByRole('button').hasAttribute('title')).toBe(false);
    });

    it('keeps an accessible name via aria-label', () => {
        renderToggle();
        expect(screen.getByRole('button')).toHaveAccessibleName(/Switch to (light|dark) theme/);
    });

    it('toggles theme on click — the tooltip wrapper must not swallow the event', async () => {
        const user = userEvent.setup();
        renderToggle();
        const button = screen.getByTestId('theme-toggle');
        const before = button.getAttribute('data-theme-current');
        await user.click(button);
        expect(button.getAttribute('data-theme-current')).not.toBe(before);
    });

    it('flips html[data-theme], the label and the pressed state together, and back', async () => {
        const user = userEvent.setup();
        renderToggle();
        const button = screen.getByTestId('theme-toggle');
        const first = button.getAttribute('data-theme-current');
        const second = first === 'dark' ? 'light' : 'dark';

        await user.click(button);
        expect(button).toHaveAttribute('data-theme-current', second);
        expect(document.documentElement).toHaveAttribute('data-theme', second);
        expect(button).toHaveAccessibleName(second === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        expect(button).toHaveAttribute('aria-pressed', String(second === 'light'));

        await user.click(button);
        expect(button).toHaveAttribute('data-theme-current', first);
        expect(document.documentElement).toHaveAttribute('data-theme', first);
    });

    it('takes a custom id', () => {
        renderToggle('ks-theme-toggle');
        expect(screen.getByRole('button')).toHaveAttribute('id', 'ks-theme-toggle');
    });
});
