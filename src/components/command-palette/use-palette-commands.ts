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
import { usePathname } from 'next/navigation';
import { APP_ROUTES, workspaceSlugFromPath } from '@/lib/app-routes';
import { useOptionalWorkspace } from '@/lib/workspace/workspace-context';

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
 * The palette's commands. Inkquisitor edit (docs/carve-manifest.md):
 * inflect's tenant-scoped compliance navigation, the assistant command and
 * the next-auth sign-out are replaced by the shell's two destinations (Books,
 * Settings) and the theme toggle. The destinations are built per workspace
 * from `APP_ROUTES`, the sidebar's own table, so the two never disagree;
 * outside a workspace there is nowhere to go and only the actions remain.
 */
export function usePaletteCommands(): PaletteCommand[] {
    const t = useTranslations('commandPalette.commands');
    const { toggle: toggleTheme } = useTheme();
    const pathname = usePathname();
    // The palette is mounted by the root providers, above the workspace
    // layout's provider, so in the app it reads the slug from the URL; the
    // context wins where there is one (a provider wrapping the palette).
    const workspaceSlug = useOptionalWorkspace()?.workspaceSlug ?? workspaceSlugFromPath(pathname);

    return useMemo<PaletteCommand[]>(() => {
        const navigation: PaletteCommand[] = workspaceSlug
            ? [
                  {
                      id: 'nav:books',
                      group: 'Navigation',
                      label: t('goToBooks'),
                      matchLabel: 'Go to Books',
                      icon: BookOpen,
                      href: APP_ROUTES.books(workspaceSlug),
                      keywords: ['book', 'books', 'manuscript', 'library'],
                  },
                  {
                      id: 'nav:settings',
                      group: 'Navigation',
                      label: t('goToSettings'),
                      matchLabel: 'Go to Settings',
                      icon: Settings,
                      href: APP_ROUTES.settings(workspaceSlug),
                      keywords: ['preferences', 'workspace', 'account', 'sessions'],
                  },
              ]
            : [];
        return [
            ...navigation,
            {
                id: 'action:toggle-theme',
                group: 'Actions',
                label: t('toggleTheme'),
                matchLabel: 'Toggle theme',
                icon: Moon,
                perform: toggleTheme,
                keywords: ['dark', 'light', 'appearance'],
            },
        ];
    }, [t, toggleTheme, workspaceSlug]);
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
