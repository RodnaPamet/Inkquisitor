'use client';

/**
 * TopChrome — the bar above every application page.
 *
 * Adapted from inflect-compliance's `TopChrome.tsx` (see
 * docs/carve-manifest.md). A thin consumer of the `<NavBar>` primitive:
 *
 *   • Left slot  — mobile menu, brand mark, breadcrumbs.
 *   • Right slot — the theme toggle, then the workspace name and the user
 *                  menu when there is a workspace, or nothing more when signed
 *                  out.
 *
 * What was left behind: the tenant and org workspace switchers (one
 * workspace per author, D4), the notifications bell and the environment
 * badge (no Inkquisitor counterpart yet), and the account-security and MFA
 * rows of the user menu (0.3 builds authentication; it adds its rows here).
 */

import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { Popover } from '@/components/ui/popover';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { useOptionalWorkspace } from '@/lib/workspace/workspace-context';
import { useCurrentBreadcrumbs } from './breadcrumbs-store';
import { WorkspaceIdentityPill } from './IdentityPill';
import { UserMenu, USER_MENU_ROW_CLASS } from './user-menu';
import { NavBar, NavBarBrand, NavBarMobileMenu } from './nav-bar';

interface TopChromeProps {
    /** Opens the mobile drawer. */
    onMobileMenuClick: () => void;
    /** Absent until sign-out exists (subphase 0.3); the row is then not rendered. */
    onLogout?: () => void | Promise<void>;
}

export function TopChrome({ onMobileMenuClick, onLogout }: TopChromeProps) {
    const t = useTranslations('nav');
    const breadcrumbs = useCurrentBreadcrumbs();
    const workspace = useOptionalWorkspace();

    return (
        <NavBar
            left={
                <>
                    <NavBarMobileMenu onClick={onMobileMenuClick} ariaLabel={t('openNavigationMenu')} />
                    <NavBarBrand href="/" initials="IQ" />
                    <span className="hidden md:inline-flex items-center">
                        {breadcrumbs.length > 0 ? (
                            <Breadcrumbs items={breadcrumbs} data-testid="top-chrome-breadcrumbs" />
                        ) : (
                            <span className="sr-only">{t('noBreadcrumbs')}</span>
                        )}
                    </span>
                </>
            }
            right={
                workspace ? (
                    <>
                        <WorkspaceIdentityPill />
                        <UserMenu
                            displayName={workspace.userName}
                            displayEmail={null}
                            displayImage={null}
                            items={
                                onLogout
                                    ? ({ close }) => (
                                          <>
                                              <Popover.Separator />
                                              <button
                                                  type="button"
                                                  onClick={() => {
                                                      close();
                                                      void onLogout();
                                                  }}
                                                  role="menuitem"
                                                  data-testid="user-menu-sign-out"
                                                  className={USER_MENU_ROW_CLASS}
                                              >
                                                  <LogOut className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                                                  <span>{t('signOut')}</span>
                                              </button>
                                          </>
                                      )
                                    : undefined
                            }
                        />
                    </>
                ) : (
                    // Signed out: no identity to show, but the theme stays
                    // reachable (inside a workspace it lives in the user menu).
                    <ThemeToggle id="top-chrome-theme-toggle" />
                )
            }
        />
    );
}
