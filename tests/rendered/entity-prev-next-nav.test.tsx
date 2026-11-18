/** @jest-environment jsdom */

/**
 * `<EntityPrevNextNav>` — the up/down record stepper beside a detail-page name.
 *
 * Two invariants, both of which were broken or latent before this suite:
 *
 * 1. It RENDERS when given real list ids. The component was never deleted —
 *    it hid itself because its caller fed it `[]` after `/assets` changed
 *    response shape. The retired structural guard asserted only that the
 *    source still *mentioned* the component, so it passed 3/3 the whole time
 *    the feature was dead. These assertions fail instead.
 *
 * 2. Its keyboard binding requires ALT. `useKeyboardShortcut` defaults
 *    `preventDefault` to true and binds on `window`, so a bare ArrowUp/Down
 *    binding would stop the arrow keys scrolling the detail page. That was
 *    invisible while the component rendered nothing.
 *
 * 3. Its labels come from the message catalog, as whole phrases per
 *    entity (inflect needed that for Bulgarian gender agreement; Inkquisitor
 *    ships English only but keeps the catalog-backed shape).
 *
 * Lifted from inflect-compliance (see docs/carve-manifest.md); the Bulgarian
 * half and the `/assets` list-envelope helper were left behind.
 */

import { fireEvent, render, within } from '@testing-library/react';
import * as React from 'react';

import {
    EntityPrevNextNav,
    STEPPER_ENTITIES,
} from '@/components/ui/entity-prev-next-nav';
import {
    KeyboardShortcutProvider,
    useRegisteredShortcuts,
} from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';
import en from '../../messages/en.json';

/**
 * Locale the local `next-intl` mock resolves against. A ref object (not a
 * bare `let`) because the mock factory is hoisted above every declaration in
 * this file — reading `.current` lazily, from inside `useTranslations`, is
 * what keeps it out of the temporal dead zone.
 */
const mockLocale: { current: 'en' } = { current: 'en' };

/**
 * Why a LOCAL mock rather than the repo-wide `__mocks__/next-intl.js`:
 *
 *   • it also hands back a FRESH `t` on every `useTranslations()` call. Any
 *     consumer that feeds `t` (or a value derived from it) into a hook
 *     dependency then re-registers on every render, and the suite TIMES OUT
 *     rather than failing — a slow, confusing way to find out. Memoising one
 *     `t` per (locale, namespace) makes the identity stable.
 */
jest.mock('next-intl', () => {
    const catalogs: Record<string, unknown> = {
        en: jest.requireActual('../../messages/en.json'),
    };
    type Translator = ((key: string) => string) & { has: (key: string) => boolean };
    const build = (locale: string, ns: string): Translator => {
        const resolve = (key: string): unknown =>
            `${ns}.${key}`
                .split('.')
                .reduce<unknown>(
                    (o, k) =>
                        o && typeof o === 'object'
                            ? (o as Record<string, unknown>)[k]
                            : undefined,
                    catalogs[locale],
                );
        return Object.assign(
            (key: string) => {
                const v = resolve(key);
                return typeof v === 'string' ? v : key;
            },
            { has: (key: string) => typeof resolve(key) === 'string' },
        );
    };
    const cache = new Map<string, Translator>();
    return {
        useTranslations: (ns: string): Translator => {
            const cacheKey = `${mockLocale.current}:${ns}`;
            let t = cache.get(cacheKey);
            if (!t) {
                t = build(mockLocale.current, ns);
                cache.set(cacheKey, t);
            }
            return t;
        },
        useLocale: () => mockLocale.current,
    };
});

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: mockReplace,
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

const hrefFor = (id: string) => `/books/${id}`;

function mount(ids: string[], currentId: string, labelSingular = 'book') {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityPrevNextNav
                    ids={ids}
                    currentId={currentId}
                    hrefFor={hrefFor}
                    labelSingular={labelSingular}
                />
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}

beforeEach(() => {
    mockReplace.mockClear();
    mockLocale.current = 'en';
});

describe('EntityPrevNextNav — renders for a real list payload', () => {
    const payload = ['a1', 'a2', 'a3'];

    it('mounts both steppers for a mid-list record', () => {
        const ids = payload;
        const { queryByTestId } = mount(ids, 'a2');
        expect(queryByTestId('entity-prev-next-nav')).not.toBeNull();
        expect(queryByTestId('entity-nav-prev')).not.toBeNull();
        expect(queryByTestId('entity-nav-next')).not.toBeNull();
    });

    it('steps to the previous and next neighbour in list order', () => {
        const ids = payload;
        const { getByTestId } = mount(ids, 'a2');

        fireEvent.click(getByTestId('entity-nav-prev'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.click(getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });

    it('disables the ends rather than wrapping around', () => {
        const ids = payload;
        const first = mount(ids, 'a1');
        expect(first.getByTestId('entity-nav-prev').hasAttribute('disabled')).toBe(true);
        expect(first.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(false);
        first.unmount();

        const last = mount(ids, 'a3');
        expect(last.getByTestId('entity-nav-next').hasAttribute('disabled')).toBe(true);
    });

    it('hides itself when there is nothing to step through', () => {
        expect(mount(['only'], 'only')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
        // Current id outside the loaded window — arrows would point nowhere.
        expect(mount(['a1', 'a2'], 'not-in-list')
            .queryByTestId('entity-prev-next-nav')).toBeNull();
    });
});

describe('EntityPrevNextNav — arrow keys need alt, so the page still scrolls', () => {
    const ids = ['a1', 'a2', 'a3'];

    it('ignores a BARE ArrowUp/ArrowDown', () => {
        mount(ids, 'a2');
        fireEvent.keyDown(window, { key: 'ArrowUp' });
        fireEvent.keyDown(window, { key: 'ArrowDown' });
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('does not preventDefault a bare ArrowDown — that is the page scroll', () => {
        mount(ids, 'a2');
        const evt = new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
    });

    it('navigates on alt+ArrowUp / alt+ArrowDown', () => {
        mount(ids, 'a2');

        fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a1'));

        mockReplace.mockClear();
        fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
        expect(mockReplace).toHaveBeenCalledWith(hrefFor('a3'));
    });
});

// A probe that RENDERS whatever the shortcut registry currently holds. The
// keyboard `description` never reaches the nav's own markup, so it is
// invisible to any query over that — but a probe can put it somewhere
// queryable, which is how tests/rendered/keyboard-shortcut-hook.test.tsx
// introspects the registry. Rendering beats reassigning a module-scope
// binding from inside a component, which the React Compiler rule refuses.
function ShortcutProbe() {
    const list = useRegisteredShortcuts();
    return (
        <ul data-testid="shortcut-registry">
            {list.map((s) => (
                <li key={s.id}>{s.description ?? '(none)'}</li>
            ))}
        </ul>
    );
}

function mountWithProbe(labelSingular: string) {
    return render(
        <TooltipProvider delayDuration={0}>
            <KeyboardShortcutProvider>
                <EntityPrevNextNav
                    ids={['a1', 'a2', 'a3']}
                    currentId="a2"
                    hrefFor={hrefFor}
                    labelSingular={labelSingular}
                />
                <ShortcutProbe />
            </KeyboardShortcutProvider>
        </TooltipProvider>,
    );
}


describe('EntityPrevNextNav — labels come from the catalog', () => {
    const ids = ['a1', 'a2', 'a3'];
    const labels = (r: ReturnType<typeof mount>) => {
        const q = within(r.container);
        return {
            prev: q.getByTestId('entity-nav-prev').getAttribute('aria-label'),
            next: q.getByTestId('entity-nav-next').getAttribute('aria-label'),
        };
    };

    it('renders the catalog phrases for a registered entity', () => {
        expect(labels(mount(ids, 'a2', 'book'))).toEqual({ prev: 'Previous book', next: 'Next book' });
    });

    it('falls back to the generic record phrase for an unregistered entity', () => {
        expect(labels(mount(ids, 'a2', 'sprocket'))).toEqual({ prev: 'Previous item', next: 'Next item' });
    });

    it('describes the keyboard shortcuts with the same phrases', () => {
        const r = mountWithProbe('book');
        const probe = within(r.container).getByTestId('shortcut-registry');
        const descriptions = Array.from(probe.querySelectorAll('li'))
            .map((li) => li.textContent)
            .sort();
        expect(descriptions).toEqual(['Next book', 'Previous book']);
    });
});

// The component gates on a local slug set instead of probing the catalog, so
// the set and the catalog are pinned to each other from both directions.
describe('the stepper entity set and the catalog agree', () => {
    const stepper = (en as unknown as {
        ui: { recordStepper: Record<'previous' | 'next', Record<string, string>> };
    }).ui.recordStepper;

    it.each(['previous', 'next'] as const)('every registered entity has a %s phrase', (direction) => {
        const missing = [...STEPPER_ENTITIES, 'item'].filter((slug) => !stepper[direction][slug]);
        expect(missing).toEqual([]);
    });

    it('every catalog phrase belongs to a registered entity', () => {
        const registered = new Set([...STEPPER_ENTITIES, 'item']);
        const orphans = (['previous', 'next'] as const).flatMap((d) =>
            Object.keys(stepper[d]).filter((k) => !registered.has(k)),
        );
        expect(orphans).toEqual([]);
    });
});
