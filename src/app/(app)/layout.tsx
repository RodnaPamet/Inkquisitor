import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceProvider } from '@/lib/workspace/workspace-context';

/**
 * The shell outside any workspace: today only `/dev/kitchen-sink` (a 404 in
 * production), which renders the chrome in its signed-out state. Workspace
 * pages live under `/w/[workspaceSlug]` and get a real workspace from that
 * layout.
 */
export default function DevShellLayout({ children }: { children: ReactNode }) {
    return (
        <WorkspaceProvider value={null}>
            <AppShell>{children}</AppShell>
        </WorkspaceProvider>
    );
}
