'use client';

/**
 * Navigation and action commands for the Command Palette.
 *
 * Adapted from inflect-compliance (Epic 57; see docs/carve-manifest.md). Two
 * curated buckets: **Navigation**, one entry per sidebar destination, so a
 * user who knows the sidebar knows the palette; and **Actions**, universally
 * safe ones only. Destructive or permission-gated actions stay out — run from
 * a palette row they would skip the confirmation UX their own surfaces carry.
 */

import { BookOpen, Moon, Settings, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, type ComponentType, type SVGProps } from 'react';

import { useTheme } from '@/components/theme/ThemeProvider';

export type PaletteCommandGroup = 'Navigation' | 'Actions';

/**
 * A lucide icon or one of the package's own SVG components (plain
 * `(props: SVGProps<SVGSVGElement>) => Element` functions, not assignable to
 * lucide's `ForwardRefExoticComponent`). See `NavItemProps.icon`.
 */
export type PaletteGlyph = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

export interface PaletteCommand {
    id: string;
    group: PaletteCommandGroup;
    label: string;
    icon: PaletteGlyph;
    /** Populated for `Navigation` commands. */
    href?: string;
    /** Populated for `Actions`. Closes the palette automatically after invocation. */
    perform?: () => void;
    /**
     * The command's English name, MATCH-ONLY. The rendered `label` is in the
     * reader's language; this keeps the English words finding the row should
     * a second locale ever ship. In English it equals the label.
     */
    matchLabel?: string;
    /**
     * MATCH-ONLY vocabulary, never rendered: words a user TYPES that should
     * not be the row's name. The label stays the thing a reader understands,
     * the keywords are the things a searcher tries.
     */
    keywords?: readonly string[];
}

/**
 * The palette's static commands. Inkquisitor edit (docs/carve-manifest.md):
 * inflect's tenant-scoped compliance navigation, the assistant command and
 * the next-auth sign-out are replaced by the shell's own two destinations
 * (Books, Settings) and the theme toggle. One workspace per author (D4), so
 * the routes carry no slug and the commands do not depend on a workspace.
 * Sign-out returns with authentication (subphase 0.3).
 */
export function usePaletteCommands(): PaletteCommand[] {
    const t = useTranslations('commandPalette.commands');
    const { toggle: toggleTheme } = useTheme();

    return useMemo<PaletteCommand[]>(
        () => [
            {
                id: 'nav:books',
                group: 'Navigation',
                label: t('goToBooks'),
                matchLabel: 'Go to Books',
                icon: BookOpen,
                href: '/books',
                keywords: ['book', 'books', 'manuscript', 'library'],
            },
            {
                id: 'nav:settings',
                group: 'Navigation',
                label: t('goToSettings'),
                matchLabel: 'Go to Settings',
                icon: Settings,
                href: '/settings',
                keywords: ['preferences', 'workspace', 'account'],
            },
            {
                id: 'action:toggle-theme',
                group: 'Actions',
                label: t('toggleTheme'),
                matchLabel: 'Toggle theme',
                icon: Moon,
                perform: toggleTheme,
                keywords: ['dark', 'light', 'appearance'],
            },
        ],
        [t, toggleTheme],
    );
}

export function filterPaletteCommands(
    commands: PaletteCommand[],
    query: string,
): PaletteCommand[] {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
        (c) =>
            c.label.toLowerCase().includes(q) ||
            c.matchLabel?.toLowerCase().includes(q) ||
            c.keywords?.some((k) => k.toLowerCase().includes(q)),
    );
}
