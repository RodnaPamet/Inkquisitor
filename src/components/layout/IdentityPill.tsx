'use client';

/**
 * The workspace identity pill in the top chrome.
 *
 * Adapted from inflect-compliance's `IdentityPill.tsx` (see
 * docs/carve-manifest.md), which had a tenant and an org variant over two
 * contexts. Inkquisitor has one workspace per author (D4), so one pill over
 * `WorkspaceContext`. Signed out it renders nothing: there is no identity to
 * show. It links to the workspace's Settings page.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { HIT_AREA_CLASS } from '@/components/ui/hit-area';
import { useOptionalWorkspace } from '@/lib/workspace/workspace-context';
import { APP_ROUTES } from '@/lib/app-routes';

const PILL_CLASS =
    `relative inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-default px-3 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${HIT_AREA_CLASS}`;

export function WorkspaceIdentityPill({ href }: { href?: string }) {
    const t = useTranslations('common.ui');
    const workspace = useOptionalWorkspace();
    if (!workspace) return null;
    const { workspaceName } = workspace;
    return (
        <Link
            href={href ?? APP_ROUTES.settings(workspace.workspaceSlug)}
            className={PILL_CLASS}
            aria-label={t('currentWorkspace', { name: workspaceName })}
            data-testid="top-chrome-workspace-pill"
        >
            <InitialsAvatar value={workspaceName} />
            <span className="max-w-trunc-tight truncate">{workspaceName}</span>
        </Link>
    );
}
