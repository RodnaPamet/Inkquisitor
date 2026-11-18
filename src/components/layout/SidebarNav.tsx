'use client';

/**
 * The application sidebar.
 *
 * Adapted from inflect-compliance's `SidebarNav.tsx` (see
 * docs/carve-manifest.md). Kept: the brand slot that doubles as the desktop
 * collapse toggle, the `<NavSection>` / `<NavItem>` composition, the inline
 * command-palette opener and the identity block at the foot. Replaced: the
 * tenant/org context (one `WorkspaceContext`), the compliance navigation
 * (Books and Settings), the Nucleo glyphs (lucide-react — the Nucleo set is
 * licensed only for the product it ships with), and the tour, admin link and
 * calendar badge, which have no Inkquisitor counterpart.
 *
 * Signed-out-safe: with no workspace the nav still renders (the routes render
 * their own signed-out state) and the identity block names nobody.
 */

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BookOpen, LogOut, Menu, Settings } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useCommandPalette } from '@/components/command-palette/command-palette-provider';
import { cn } from '@inkquisitor/ui/lib/cn';
import { useOptionalWorkspace, type WorkspaceRole } from '@/lib/workspace/workspace-context';
import { NavItem } from './nav-item';
import type { NavGlyph } from './nav-item';
import { NavSection } from './nav-section';
import { useSidebarCollapsed } from './sidebar-collapse-context';

interface NavItemDef {
    href: string;
    label: string;
    icon: NavGlyph;
}

interface NavSectionDef {
    title?: string;
    items: NavItemDef[];
}

/** The application's routes. One workspace per author (D4), so no slug. */
export const APP_ROUTES = {
    books: '/books',
    settings: '/settings',
} as const;

export function useNavSections(): NavSectionDef[] {
    const t = useTranslations('nav');
    return [
        {
            items: [
                { href: APP_ROUTES.books, label: t('books'), icon: BookOpen },
                { href: APP_ROUTES.settings, label: t('settings'), icon: Settings },
            ],
        },
    ];
}

/** True when `pathname` is `href` or below it (segment-bounded). */
export function isNavItemActive(pathname: string | null, href: string): boolean {
    if (!pathname) return false;
    return pathname === href || pathname.startsWith(`${href}/`);
}

const ROLE_KEYS: Record<WorkspaceRole, 'owner' | 'editor' | 'reader'> = {
    OWNER: 'owner',
    EDITOR: 'editor',
    READER: 'reader',
};

interface SidebarContentProps {
    /** Absent until sign-out exists (subphase 0.3); the button is then not rendered. */
    onLogout?: () => void;
    onNavClick?: () => void;
    /** Desktop only — when provided, renders the collapse/expand toggle. */
    onToggleCollapse?: () => void;
}

export function SidebarContent({ onLogout, onNavClick, onToggleCollapse }: SidebarContentProps) {
    const pathname = usePathname();
    const tc = useTranslations('common');
    const tn = useTranslations('nav');
    const tRoles = useTranslations('roles');
    const workspace = useOptionalWorkspace();
    const sections = useNavSections();
    const { open: openPalette } = useCommandPalette();
    const collapsed = useSidebarCollapsed();

    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b border-border-subtle">
                {onToggleCollapse ? (
                    <button
                        type="button"
                        onClick={onToggleCollapse}
                        aria-label={
                            collapsed
                                ? tn('expandSidebar')
                                : tn('collapseSidebarNamed', { app: tc('appName') })
                        }
                        aria-pressed={collapsed}
                        data-testid="sidebar-collapse-toggle"
                        className={cn(
                            'flex w-full items-center rounded-lg text-content-muted transition-colors hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                            collapsed ? 'justify-center' : 'gap-tight',
                        )}
                    >
                        <Menu className="h-5 w-5 shrink-0" aria-hidden="true" />
                        {!collapsed && (
                            <span className="text-sm font-semibold text-content-emphasis truncate">
                                {tc('appName')}
                            </span>
                        )}
                    </button>
                ) : (
                    <div className="flex items-center gap-tight">
                        <div className="w-8 h-8 rounded-lg bg-[var(--brand-default)] flex items-center justify-center flex-shrink-0">
                            <span className="text-content-inverted text-sm font-bold">IQ</span>
                        </div>
                        <span className="text-sm font-semibold text-content-emphasis truncate">
                            {tc('appName')}
                        </span>
                    </div>
                )}
            </div>

            <nav className="flex-1 p-2 overflow-y-auto" aria-label={tn('mainNavigation')}>
                {sections.map((section, idx) => (
                    <NavSection key={idx} title={section.title} isFirst={idx === 0}>
                        {section.items.map((item) => (
                            <NavItem
                                key={item.href}
                                href={item.href}
                                icon={item.icon}
                                label={item.label}
                                active={isNavItemActive(pathname, item.href)}
                                onClick={onNavClick}
                            />
                        ))}
                    </NavSection>
                ))}
            </nav>

            <button
                type="button"
                onClick={() => {
                    onNavClick?.();
                    openPalette();
                }}
                className={cn(
                    'mx-2 mb-2 flex items-center rounded-lg border border-border-subtle bg-bg-default px-3 py-2 text-xs text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]',
                    collapsed ? 'justify-center' : 'gap-tight',
                )}
                aria-label={collapsed ? tn('openCommandPalette') : undefined}
                data-testid="sidebar-search-anchor"
            >
                <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <circle cx="7" cy="7" r="5" />
                    <path d="M11 11l3 3" />
                </svg>
                {!collapsed && <span className="flex-1 text-left">{tc('search')}</span>}
                {!collapsed && (
                    <span
                        className="hidden items-center gap-[2px] rounded border border-border-subtle bg-bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-content-subtle md:flex"
                        aria-hidden="true"
                    >
                        <span>⌘</span>
                        <span>K</span>
                    </span>
                )}
            </button>

            <div className="p-3 border-t border-border-subtle" data-testid="sidebar-identity">
                <div className={cn('flex gap-tight', collapsed ? 'flex-col items-center' : 'items-center justify-between')}>
                    {!collapsed && (
                        <div className="min-w-0">
                            {workspace ? (
                                <>
                                    <p className="text-xs font-medium text-content-default truncate">
                                        {workspace.userName ?? tn('account')}
                                    </p>
                                    <p className="text-xs text-content-muted truncate">{workspace.workspaceName}</p>
                                    <p className="text-xs text-content-muted">{tRoles(ROLE_KEYS[workspace.role])}</p>
                                </>
                            ) : (
                                <p className="text-xs text-content-muted" data-testid="sidebar-signed-out">
                                    {tn('signedOut')}
                                </p>
                            )}
                        </div>
                    )}
                    {workspace && onLogout ? (
                        <Tooltip content={tc('signOut')} side={collapsed ? 'right' : 'top'}>
                            <button
                                type="button"
                                onClick={onLogout}
                                aria-label={tc('signOut')}
                                data-testid="nav-logout"
                                className="icon-btn icon-btn-sm"
                            >
                                <LogOut className="size-4" aria-hidden="true" />
                            </button>
                        </Tooltip>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
