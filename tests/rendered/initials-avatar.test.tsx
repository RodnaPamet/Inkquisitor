/** @jest-environment jsdom */

/**
 * Rendered (Tier-2) test — `<InitialsAvatar>` + `getInitials`.
 *
 * The initials primitive replaced four divergent per-component
 * `initials*()` helpers. This pins the unified behaviour: the
 * tokenisation modes, the empty-input placeholder, the size
 * presets, and the decorative `aria-hidden` contract.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { InitialsAvatar, getInitials } from '@/components/ui/initials-avatar';

describe('getInitials', () => {
    it('two-word name → first + last initial', () => {
        expect(getInitials('Ada Lovelace')).toBe('AL');
    });

    it('three-word name → first + last (middle skipped)', () => {
        expect(getInitials('Ada Byron Lovelace')).toBe('AL');
    });

    it('single word → one initial', () => {
        expect(getInitials('Cher')).toBe('C');
    });

    it('slug mode tokenises on hyphen and underscore', () => {
        expect(getInitials('acme-corp', 'slug')).toBe('AC');
        expect(getInitials('big_co', 'slug')).toBe('BC');
    });

    it('name mode does NOT split a hyphenated slug', () => {
        expect(getInitials('acme-corp')).toBe('A');
    });

    it('empty / whitespace / null / undefined → placeholder', () => {
        expect(getInitials('')).toBe('·');
        expect(getInitials('   ')).toBe('·');
        expect(getInitials(null)).toBe('·');
        expect(getInitials(undefined)).toBe('·');
    });
});

describe('<InitialsAvatar>', () => {
    // The glyphs are painted from `data-initials` by a `::before`, never
    // written as text: text in a named control's subtree reads as a visible
    // label its name must contain (axe label-content-name-mismatch, 1.H).
    it('renders the derived initials (name mode), painted rather than written as text', () => {
        const { container } = render(<InitialsAvatar value="Ada Lovelace" />);
        const avatar = container.firstChild as HTMLElement;
        expect(avatar).toHaveAttribute('data-initials', 'AL');
        expect(avatar.className).toContain('before:content-[attr(data-initials)]');
        expect(avatar.textContent).toBe('');
    });

    it('renders slug initials in slug mode', () => {
        const { container } = render(<InitialsAvatar value="acme-corp" mode="slug" />);
        expect(container.firstChild).toHaveAttribute('data-initials', 'AC');
    });

    it('is decorative — aria-hidden, so the parent control owns the label', () => {
        const { container } = render(<InitialsAvatar value="Ada Lovelace" />);
        expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('size presets resolve to distinct dimension classes', () => {
        const sm = render(<InitialsAvatar value="X" size="sm" />);
        const md = render(<InitialsAvatar value="X" size="md" />);
        const lg = render(<InitialsAvatar value="X" size="lg" />);
        expect((sm.container.firstChild as HTMLElement).className).toContain('h-5');
        expect((md.container.firstChild as HTMLElement).className).toContain('h-8');
        // `lg` — the account-profile preview size (avatar roadmap P3).
        expect((lg.container.firstChild as HTMLElement).className).toContain('h-16');
    });

    // The initials are TEXT sitting on the brand tint, so they take a
    // CONTENT token. `--brand-emphasis` — a fill token — measured
    // 4.25:1 against that tint composited over `--bg-default` on the
    // dark theme (under WCAG 1.4.3's 4.5:1) and 4.51:1 on light, i.e.
    // clearing it by a hundredth. `--content-emphasis` is 7.00:1 and
    // 14.36:1 on the same two grounds.
    it('paints the initials with a content token, not a brand FILL token', () => {
        const { container } = render(<InitialsAvatar value="Ada Lovelace" />);
        const classes = Array.from(
            (container.firstChild as HTMLElement).classList,
        );
        expect(classes).toContain('text-content-emphasis');
        expect(
            classes.filter((c) => /^text-\[var\(--brand-/.test(c)),
        ).toEqual([]);
        // The brand TINT is the background and stays — the fix is
        // about the glyphs on it, not about dropping the brand.
        expect(classes).toContain('bg-[var(--brand-subtle)]');
    });
});

describe('<InitialsAvatar> — image-backed (avatar roadmap P2)', () => {
    it('renders no <img> when imageUrl is absent — initials only', () => {
        const { container } = render(<InitialsAvatar value="Ada Lovelace" />);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(container.firstChild).toHaveAttribute('data-initials', 'AL');
    });

    it('renders the image at the supplied URL when imageUrl is given', () => {
        const { container } = render(
            <InitialsAvatar
                value="Ada Lovelace"
                imageUrl="https://cdn.example.com/ada.jpg"
            />,
        );
        const img = screen.getByTestId('initials-avatar-image');
        expect(img).toHaveAttribute('src', 'https://cdn.example.com/ada.jpg');
        // Initials stay underneath as the fallback layer.
        expect(container.firstChild).toHaveAttribute('data-initials', 'AL');
    });

    it('falls back to initials when the image fails to load', () => {
        const { container } = render(
            <InitialsAvatar
                value="Ada Lovelace"
                imageUrl="https://cdn.example.com/broken.jpg"
            />,
        );
        const img = screen.getByTestId('initials-avatar-image');
        // Simulate a load failure → the <img> is dropped, never a
        // broken-image glyph; the initials beneath carry through.
        fireEvent.error(img);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(container.firstChild).toHaveAttribute('data-initials', 'AL');
    });

    it('a null imageUrl is treated as initials-only', () => {
        const { container } = render(<InitialsAvatar value="Cher" imageUrl={null} />);
        expect(screen.queryByTestId('initials-avatar-image')).toBeNull();
        expect(container.firstChild).toHaveAttribute('data-initials', 'C');
    });
});
