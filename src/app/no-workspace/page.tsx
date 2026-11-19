import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { getSessionUser } from '@/app-layer/context';

export const metadata: Metadata = { title: 'No workspace — Inkquisitor' };
export const dynamic = 'force-dynamic';

/**
 * Where the workspace gate sends a page request for a workspace the session
 * does not belong to (or that does not exist — the same answer, so slugs
 * cannot be probed).
 */
export default async function NoWorkspacePage() {
    const t = await getTranslations('noWorkspace');
    const user = await getSessionUser();
    return (
        <AuthCard id="no-workspace" title={t('title')} description={t('description')}>
            <Link href="/" className="block text-sm font-medium text-content-emphasis underline" id="no-workspace-home">
                {t('home')}
            </Link>
            {user ? <SignOutButton variant="secondary" /> : null}
        </AuthCard>
    );
}
