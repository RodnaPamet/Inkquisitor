/**
 * <ScrollContainer> — a scroller with a bottom fade.
 *
 * No inflect-compliance suite exists for it on its own (inflect covers it
 * through the combobox and checklist suites, ported here too), so this one is
 * new. By default it WRAPS its children in the scrolling element; with
 * `asChild` the single child itself becomes the scroller, keeping its own
 * role and classes, which is what lets a listbox be the scroller.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { ScrollContainer } from '@/components/ui/scroll-container';

describe('<ScrollContainer>', () => {
    it('wraps its children in a vertical scroller', () => {
        render(
            <ScrollContainer className="max-h-40">
                <p>Chapter one</p>
            </ScrollContainer>,
        );
        const scroller = screen.getByText('Chapter one').parentElement!;
        expect(scroller).toHaveClass('overflow-y-scroll', 'max-h-40');
    });

    it('asChild makes the child the scroller, keeping its role and classes', () => {
        render(
            <ScrollContainer asChild className="max-h-40">
                <ul role="listbox" aria-label="Chapters" className="py-1">
                    <li role="option" aria-selected={false}>
                        Chapter one
                    </li>
                </ul>
            </ScrollContainer>,
        );
        const list = screen.getByRole('listbox', { name: 'Chapters' });
        expect(list).toHaveClass('overflow-y-scroll', 'max-h-40', 'py-1');
        expect(list.parentElement!.tagName).toBe('DIV');
        expect(list.parentElement).not.toHaveClass('overflow-y-scroll');
    });
});
