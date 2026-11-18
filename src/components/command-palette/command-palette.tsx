'use client';

/**
 * The Command Palette surface — the shell, with no entity search yet.
 *
 * Adapted from inflect-compliance's Epic 57 palette (see
 * docs/carve-manifest.md). Hosts `cmdk` inside a Radix Dialog so the palette
 * gets the same focus trap, backdrop and portal guarantees as every other
 * overlay. Opening is owned by `CommandPaletteProvider` (`mod+k`); this file
 * only renders the surface: a search input, the Navigation and Actions
 * groups from `usePaletteCommands`, and a "Keyboard shortcuts" group seeded
 * from the shared registry.
 *
 * Left behind: inflect's entity search (controls, risks, policies, …), its
 * per-type filter chips and the per-tenant recents. Inkquisitor's entity
 * search (books, bible entries) arrives with the entities; it slots in as
 * further `Command.Group`s inside `Command.List`.
 *
 * Accessibility:
 *   - Radix Dialog provides `role="dialog"` + focus trap + Escape close.
 *   - A visually-hidden `Dialog.Title` satisfies Radix's a11y contract.
 *   - cmdk's `Command.Input` carries `role="combobox"` + `aria-expanded`
 *     + `aria-controls`; selected items emit `data-selected="true"`.
 */

import * as Dialog from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { cn } from '@inkquisitor/ui/lib/cn';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
    useRegisteredShortcuts,
    type RegisteredShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';

import { useCommandPalette } from './command-palette-provider';
import {
    filterPaletteCommands,
    usePaletteCommands,
    type PaletteCommand,
} from './use-palette-commands';

// ─── Key rendering helpers ─────────────────────────────────────────────

function isMac(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function prettifyKeyToken(token: string): string {
    const t = token.trim().toLowerCase();
    if (t === 'mod') return isMac() ? '⌘' : 'Ctrl';
    if (t === 'meta' || t === 'cmd' || t === 'command') return '⌘';
    if (t === 'ctrl' || t === 'control') return 'Ctrl';
    // macOS uses the glyph U+2325 for Option, which reads as an emoji-like
    // pictograph in UI chrome. Render text "Alt" on both platforms —
    // recognisable everywhere.
    if (t === 'alt' || t === 'opt' || t === 'option') return 'Alt';
    if (t === 'shift') return '⇧';
    if (t === 'enter' || t === 'return') return '↵';
    if (t === 'escape' || t === 'esc') return 'Esc';
    if (t === 'arrowup') return '↑';
    if (t === 'arrowdown') return '↓';
    if (t === 'arrowleft') return '←';
    if (t === 'arrowright') return '→';
    if (t.length === 1) return t.toUpperCase();
    // Named key: "Tab", "Backspace", "Delete", etc. Title-case it.
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function renderShortcut(raw: string): ReactNode {
    // Split on `+`, preserving a literal trailing `+` the parser lets through.
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '+' && buf.length > 0 && i < raw.length - 1) {
            parts.push(buf);
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf.length > 0) parts.push(buf);

    return parts.map((p, i) => (
        <kbd
            key={`${p}-${i}`}
            className={cn(
                'ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center',
                'rounded border border-border-subtle bg-bg-muted px-1.5',
                'text-[10px] font-medium text-content-muted',
            )}
        >
            {prettifyKeyToken(p)}
        </kbd>
    ));
}

// ─── Component ─────────────────────────────────────────────────────────

/**
 * Renders nothing until the provider says `isOpen`. Mounting as a
 * portal keeps the palette isolated from layout and always on top.
 */
export function CommandPalette() {
    const t = useTranslations('commandPalette');
    const { isOpen, close } = useCommandPalette();
    const shortcuts = useRegisteredShortcuts();
    const router = useRouter();

    const [query, setQuery] = useState('');

    // Navigation + action commands. When the user has started typing,
    // we fold the shortcut group away so the narrower, intent-driven
    // Navigation / Actions stack owns the surface.
    const allCommands = usePaletteCommands();
    const filteredCommands = filterPaletteCommands(allCommands, query);
    const navCommands = filteredCommands.filter((c) => c.group === 'Navigation');
    const actionCommands = filteredCommands.filter((c) => c.group === 'Actions');

    const showShortcuts = query.trim().length === 0;

    // Registry-derived lookup: palette command `label` → first
    // registered shortcut key whose description matches exactly. The
    // registry stays the single source of truth for the binding; this
    // map is metadata for render only, so the keycap is NEVER wrong
    // about what actually fires.
    const shortcutsByDescription = useMemo(() => {
        const map = new Map<string, string>();
        for (const s of shortcuts) {
            if (!s.description) continue;
            if (s.keys.length === 0) continue;
            if (!map.has(s.description)) map.set(s.description, s.keys[0]);
        }
        return map;
    }, [shortcuts]);
    const shortcutFor = useCallback(
        (label: string): string | undefined =>
            shortcutsByDescription.get(label),
        [shortcutsByDescription],
    );

    // The palette's own `mod+k` binding shouldn't clutter the list —
    // it's the invocation affordance, not a first-class command.
    // Also fold out any shortcut whose description matches a palette
    // command we're already rendering inline (we display its keycap
    // on the action row itself — listing it again in the shortcut
    // group would be noise).
    const allCommandLabels = useMemo(
        () => new Set(allCommands.map((c) => c.label)),
        [allCommands],
    );
    const listedShortcuts = shortcuts.filter(
        (s) =>
            s.description &&
            s.description !== t('openShortcut') &&
            !allCommandLabels.has(s.description),
    );

    const handleSelect = (href: string) => {
        close();
        // Reset the query so the next open starts fresh.
        setQuery('');
        router.push(href);
    };

    const handleAction = (perform: () => void) => {
        close();
        setQuery('');
        // Let the close animation kick before running the action so
        // a sign-out redirect doesn't race the portal teardown.
        queueMicrotask(() => perform());
    };

    // Reset the query when the palette closes so
    // the next open starts clean. Covers the backdrop-click and
    // Escape paths that don't go through `handleSelect`.
    useEffect(() => {
        if (!isOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setQuery('');
        }
    }, [isOpen]);

    return (
        <Dialog.Root open={isOpen} onOpenChange={(next) => !next && close()}>
            <Dialog.Portal>
                <Dialog.Overlay
                    data-modal-overlay
                    className={cn(
                        'fixed inset-0 z-50',
                        'bg-bg-overlay backdrop-blur-sm',
                        'data-[state=open]:animate-fade-in',
                    )}
                />
                <Dialog.Content
                    aria-label={t('title')}
                    onOpenAutoFocus={(e) => {
                        // Radix focuses the first focusable child. cmdk's
                        // `Command.Input` is first in the tree and gets it
                        // by default. `preventDefault()` here would KEEP
                        // focus on the previously active element, so leave
                        // Radix's default behaviour in place.
                        e.stopPropagation();
                    }}
                    className={cn(
                        'fixed left-1/2 top-[20%] z-50 w-[92vw] max-w-[640px]',
                        '-translate-x-1/2',
                        'rounded-xl border border-border-default bg-bg-elevated shadow-2xl',
                        'text-content-emphasis',
                        'data-[state=open]:animate-fade-in',
                        'focus-visible:outline-none',
                    )}
                    data-command-palette
                >
                    <VisuallyHidden.Root>
                        <Dialog.Title>{t('title')}</Dialog.Title>
                        <Dialog.Description>
                            {t('description')}
                        </Dialog.Description>
                    </VisuallyHidden.Root>

                    <Command
                        loop
                        // `filterPaletteCommands` already filters on label,
                        // English name and keywords; cmdk's own filter would
                        // filter again against each item's `value` (its id).
                        shouldFilter={false}
                        className="flex flex-col"
                        label={t('title')}
                    >
                        <div
                            className={cn(
                                'flex items-center gap-tight border-b border-border-subtle',
                                'px-4 py-3',
                            )}
                        >
                            <Search
                                className="size-4 shrink-0 text-content-muted"
                                aria-hidden="true"
                            />
                            <Command.Input
                                autoFocus
                                value={query}
                                onValueChange={setQuery}
                                placeholder={t('searchPlaceholder')}
                                className={cn(
                                    'flex-1 bg-transparent text-sm',
                                    'text-content-emphasis placeholder:text-content-subtle',
                                    'focus:outline-none',
                                )}
                                data-testid="command-palette-input"
                            />
                            <kbd
                                className={cn(
                                    'hidden shrink-0 items-center rounded border',
                                    'border-border-subtle bg-bg-muted px-1.5 py-0.5',
                                    'text-[10px] font-medium text-content-muted',
                                    'sm:inline-flex',
                                )}
                            >
                                Esc
                            </kbd>
                        </div>

                        <Command.List
                            className={cn(
                                'max-h-[min(60vh,420px)] overflow-y-auto',
                                'p-2',
                            )}
                            data-testid="command-palette-list"
                        >
                            <Command.Empty
                                className={cn(
                                    'py-10 text-center text-sm text-content-muted',
                                )}
                            >
                                {t('noResults')}
                            </Command.Empty>

                            {navCommands.length > 0 && (
                                <CommandGroup
                                    heading={t('groupNavigation')}
                                    items={navCommands}
                                    testIdPrefix="nav"
                                    onNavigate={handleSelect}
                                    onAction={handleAction}
                                    shortcutFor={shortcutFor}
                                />
                            )}

                            {actionCommands.length > 0 && (
                                <CommandGroup
                                    heading={t('groupActions')}
                                    items={actionCommands}
                                    testIdPrefix="action"
                                    onNavigate={handleSelect}
                                    onAction={handleAction}
                                    shortcutFor={shortcutFor}
                                />
                            )}

                            {/*
                             * Keyboard-shortcut discoverability: show
                             * only when the user hasn't started typing
                             * — keeps the search surface uncluttered.
                             */}
                            {showShortcuts && listedShortcuts.length > 0 && (
                                <ShortcutGroup
                                    heading={t('groupShortcuts')}
                                    items={listedShortcuts}
                                />
                            )}
                        </Command.List>
                    </Command>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function CommandGroup({
    heading,
    items,
    testIdPrefix,
    onNavigate,
    onAction,
    shortcutFor,
}: {
    heading: string;
    items: PaletteCommand[];
    testIdPrefix: string;
    onNavigate: (href: string) => void;
    onAction: (perform: () => void) => void;
    /**
     * Resolves a palette command's `label` → the first registered
     * shortcut key that advertises the same description, or
     * `undefined` if nothing is registered. Lets palette rows display
     * their keyboard affordance without duplicating the binding:
     * the registry remains the authoritative source, and the palette
     * only surfaces what's there.
     */
    shortcutFor: (label: string) => string | undefined;
}) {
    return (
        <Command.Group
            heading={heading}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
        >
            {items.map((c) => {
                const Icon = c.icon;
                const shortcutKey = shortcutFor(c.label);
                return (
                    <Command.Item
                        key={c.id}
                        value={c.id}
                        onSelect={() => {
                            if (c.href) onNavigate(c.href);
                            else if (c.perform) onAction(c.perform);
                        }}
                        className={cn(
                            'flex cursor-pointer items-center gap-compact rounded-md px-2 py-2 text-sm',
                            'text-content-default',
                            'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                        )}
                        data-testid={`command-palette-${testIdPrefix}-${c.id}`}
                        data-href={c.href}
                    >
                        <Icon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-content-muted"
                        />
                        <span className="min-w-0 flex-1 break-words">{c.label}</span>
                        {shortcutKey && (
                            <span
                                className="flex shrink-0 items-center"
                                data-testid={`command-palette-${testIdPrefix}-${c.id}-shortcut`}
                            >
                                {renderShortcut(shortcutKey)}
                            </span>
                        )}
                    </Command.Item>
                );
            })}
        </Command.Group>
    );
}

function ShortcutGroup({
    heading,
    items,
}: {
    heading: string;
    items: RegisteredShortcut[];
}) {
    return (
        <Command.Group
            heading={heading}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
        >
            {items.map((s) => (
                <Command.Item
                    key={s.id}
                    value={`${s.description ?? ''} ${s.keys.join(' ')}`}
                    className={cn(
                        'flex cursor-default items-center justify-between gap-compact',
                        'rounded-md px-2 py-2 text-sm',
                        'text-content-default',
                        'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                    )}
                    data-testid="command-palette-shortcut"
                >
                    <span className="min-w-0 flex-1 break-words">{s.description}</span>
                    <span className="flex items-center">
                        {s.keys.slice(0, 1).map((k) => (
                            <span key={k} className="flex items-center">
                                {renderShortcut(k)}
                            </span>
                        ))}
                    </span>
                </Command.Item>
            ))}
        </Command.Group>
    );
}
