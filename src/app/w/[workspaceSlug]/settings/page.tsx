import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/PageHeader';
import { SessionsPanel } from '@/components/settings/SessionsPanel';
import { getUserCtx } from '@/app-layer/context';
import { listMySessions } from '@/app-layer/usecases/sessions';
import { currentSessionId } from '@/lib/auth/current-session';

export const metadata: Metadata = { title: 'Settings — Inkquisitor' };
export const dynamic = 'force-dynamic';

/**
 * Settings. Today one section: the signed-in person's sessions, with
 * per-session sign-out and "sign out other sessions". The layout has already
 * checked the workspace membership.
 */
export default async function SettingsPage() {
    const t = await getTranslations('pages.settings');
    const ctx = await getUserCtx();
    const sessions = await listMySessions(ctx, await currentSessionId());
    return (
        <div className="space-y-section" data-testid="settings-page">
            <PageHeader title={t('title')} description={t('description')} />
            <SessionsPanel initialSessions={sessions} />
        </div>
    );
}
