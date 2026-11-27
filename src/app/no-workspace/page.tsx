import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { RestorableWorkspaces } from '@/components/settings/RestorableWorkspaces';
import { getSessionUser, getUserCtx } from '@/app-layer/context';
import { listRestorableWorkspaces } from '@/app-layer/usecases/workspace-deletion';

export const metadata: Metadata = { title: 'No workspace — Inkquisitor' };
export const dynamic = 'force-dynamic';

/**
 * Where the workspace gate sends a page request for a workspace the session
 * does not belong to (or that does not exist — the same answer, so slugs
 * cannot be probed). Since Phase 5.H-a it also lists the signed-in person's
 * DELETED workspaces they may still restore (an OWNER's, within 30 days).
 */
export default async function NoWorkspacePage() {
    const t = await getTranslations('noWorkspace');
    const user = await getSessionUser();
    const restorable = user ? (await listRestorableWorkspaces(await getUserCtx())).workspaces : [];
    return (
        <AuthCard id="no-workspace" title={t('title')} description={t('description')}>
            <RestorableWorkspaces workspaces={restorable} />
            <Link href="/" className="block text-sm font-medium text-content-emphasis underline" id="no-workspace-home">
                {t('home')}
            </Link>
            {user ? <SignOutButton variant="secondary" /> : null}
        </AuthCard>
    );
}
