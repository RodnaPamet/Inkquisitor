import type { ReactNode } from 'react';
import { WorkspaceAppShell } from '@/components/layout/WorkspaceAppShell';
import { WorkspaceProvider } from '@/lib/workspace/workspace-context';
import { getCurrentWorkspace } from '@/lib/workspace/current-workspace';

export const dynamic = 'force-dynamic';

/**
 * Every page in a workspace renders inside the shell with that workspace in
 * context. `getCurrentWorkspace` checks the membership in the database (the
 * edge gate only pre-filters on the JWT claim) and redirects a visitor with no
 * session to /login and a non-member to /no-workspace.
 */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ workspaceSlug: string }> }) {
    const { workspaceSlug } = await params;
    const workspace = await getCurrentWorkspace(workspaceSlug);
    return (
        <WorkspaceProvider value={workspace}>
            <WorkspaceAppShell>{children}</WorkspaceAppShell>
        </WorkspaceProvider>
    );
}
