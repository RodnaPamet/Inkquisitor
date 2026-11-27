import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/PageHeader';
import { AiUseStatement } from '@/components/settings/AiUseStatement';
import { SessionsPanel } from '@/components/settings/SessionsPanel';
import { YourDataPanel } from '@/components/settings/YourDataPanel';
import { getUserCtx, getWorkspacePageCtx } from '@/app-layer/context';
import { listMySessions } from '@/app-layer/usecases/sessions';
import { currentSessionId } from '@/lib/auth/current-session';

export const metadata: Metadata = { title: 'Settings — Inkquisitor' };
export const dynamic = 'force-dynamic';

/**
 * Settings: the signed-in person's sessions; "How Inkquisitor uses AI", the written D3 statement every member reads
 * (Phase 5.H-a, roadmap 5.H item 5); and "Your data", the OWNER's full export and whole-workspace deletion (5.H-a,
 * D36), offered only when the role's permission set holds them.
 */
export default async function SettingsPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
    const t = await getTranslations('pages.settings');
    const { workspaceSlug } = await params;
    const { ctx: workspace, workspaceName } = await getWorkspacePageCtx(workspaceSlug);
    const ctx = await getUserCtx();
    const sessions = await listMySessions(ctx, await currentSessionId());
    return (
        <div className="space-y-section" data-testid="settings-page">
            <PageHeader title={t('title')} description={t('description')} />
            <SessionsPanel initialSessions={sessions} />
            <AiUseStatement />
            <YourDataPanel
                workspaceSlug={workspace.workspaceSlug}
                workspaceName={workspaceName}
                canExport={workspace.permissions.workspace.export}
                canDelete={workspace.permissions.workspace.delete}
            />
        </div>
    );
}
