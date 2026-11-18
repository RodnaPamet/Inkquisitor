/**
 * `<Accordion>` — the Radix accordion with Inkquisitor's trigger and item
 * recipes (lifted from inflect-compliance, which had no suite for it).
 *
 * Behaviour, not class strings: a single-type accordion opens one panel at a
 * time, a collapsible one closes on a second click, the trigger reports its
 * state to assistive tech and the closed panel's content is not exposed.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { axe } from 'jest-axe';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

function mount(props: Partial<React.ComponentProps<typeof Accordion>> = {}) {
    return render(
        <Accordion type="single" collapsible {...(props as object)}>
            <AccordionItem value="setting">
                <AccordionTrigger>Setting</AccordionTrigger>
                <AccordionContent>A lighthouse on a northern coast.</AccordionContent>
            </AccordionItem>
            <AccordionItem value="cast">
                <AccordionTrigger variant="plus">Cast</AccordionTrigger>
                <AccordionContent>The keeper and the storm.</AccordionContent>
            </AccordionItem>
        </Accordion>,
    );
}

const trigger = (name: string) => screen.getByRole('button', { name });

describe('<Accordion>', () => {
    it('starts closed, with the content not exposed', () => {
        mount();
        expect(trigger('Setting')).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('A lighthouse on a northern coast.')).toBeNull();
    });

    it('opens a panel on click and exposes its content', () => {
        mount();
        fireEvent.click(trigger('Setting'));
        expect(trigger('Setting')).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('A lighthouse on a northern coast.')).toBeVisible();
    });

    it('single type: opening one panel closes the other', () => {
        mount();
        fireEvent.click(trigger('Setting'));
        fireEvent.click(trigger('Cast'));
        expect(trigger('Cast')).toHaveAttribute('aria-expanded', 'true');
        expect(trigger('Setting')).toHaveAttribute('aria-expanded', 'false');
    });

    it('collapsible: a second click closes the open panel', () => {
        mount();
        fireEvent.click(trigger('Setting'));
        fireEvent.click(trigger('Setting'));
        expect(trigger('Setting')).toHaveAttribute('aria-expanded', 'false');
    });

    it('multiple type keeps several panels open', () => {
        render(
            <Accordion type="multiple">
                <AccordionItem value="a">
                    <AccordionTrigger>One</AccordionTrigger>
                    <AccordionContent>First</AccordionContent>
                </AccordionItem>
                <AccordionItem value="b">
                    <AccordionTrigger>Two</AccordionTrigger>
                    <AccordionContent>Second</AccordionContent>
                </AccordionItem>
            </Accordion>,
        );
        fireEvent.click(trigger('One'));
        fireEvent.click(trigger('Two'));
        expect(trigger('One')).toHaveAttribute('aria-expanded', 'true');
        expect(trigger('Two')).toHaveAttribute('aria-expanded', 'true');
    });

    it('the trigger is a heading-wrapped button with its glyph hidden from assistive tech', () => {
        const { container } = mount();
        expect(trigger('Setting').closest('h3')).not.toBeNull();
        expect(trigger('Setting').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
        expect(container.querySelectorAll('h3')).toHaveLength(2);
    });

    it('has no axe violations, open or closed', async () => {
        const { container } = mount();
        expect(await axe(container)).toHaveNoViolations();
        fireEvent.click(trigger('Setting'));
        expect(await axe(container)).toHaveNoViolations();
    });
});
