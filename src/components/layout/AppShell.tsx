'use client';

/**
 * Client-side app shell.
 *
 * Adapted from inflect-compliance's `AppShell.tsx` (see
 * docs/carve-manifest.md). Mounts the chrome around every application page —
 * the desktop sidebar (collapsible to an icon rail), the mobile drawer, the
 * top chrome and the breadcrumbs provider — through `<AppShellFrame>`, which
 * is lifted unchanged.
 *
 * inflect threads a server-resolved `user` with tenant and org memberships
 * through props and has two sidebar variants. Inkquisitor has one workspace
 * per author (D4): every piece of chrome reads `useOptionalWorkspace()`, so the
 * shell takes no identity props at all, and renders a signed-out-safe state
 * when the workspace is `null` (today always, until subphase 0.3).
 *
 * `onLogout` is optional for the same reason: authentication arrives in 0.3,
 * which passes it in. Without it no sign-out control is rendered.
 */

import { SidebarContent } from '@/components/layout/SidebarNav';
import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
import { AppShellFrame } from '@/components/layout/AppShellFrame';
import { SidebarCollapseProvider } from '@/components/layout/sidebar-collapse-context';
import { BreadcrumbsProvider } from './breadcrumbs-store';
import { TopChrome } from './TopChrome';

interface AppShellProps {
    onLogout?: () => void;
    children: React.ReactNode;
}

export function AppShell({ onLogout, children }: AppShellProps) {
    return (
        <AppShellFrame
            sidebar={({ collapsed, onToggleCollapse }) => (
                <SidebarCollapseProvider collapsed={collapsed}>
                    <SidebarContent onLogout={onLogout} onToggleCollapse={onToggleCollapse} />
                </SidebarCollapseProvider>
            )}
            // The drawer is never collapsed — it has the width to show
            // labels, and an icon rail inside a panel the user deliberately
            // opened would be hiding what they opened it for.
            mobileNav={({ open, onClose }) => (
                <MobileNavDrawer open={open} onClose={onClose}>
                    <SidebarCollapseProvider collapsed={false}>
                        <SidebarContent onLogout={onLogout} onNavClick={onClose} />
                    </SidebarCollapseProvider>
                </MobileNavDrawer>
            )}
            topChrome={({ onMobileMenuClick }) => (
                <TopChrome onMobileMenuClick={onMobileMenuClick} onLogout={onLogout} />
            )}
            mainProvider={(node) => <BreadcrumbsProvider>{node}</BreadcrumbsProvider>}
        >
            {children}
        </AppShellFrame>
    );
}
