import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceProvider } from '@/lib/workspace/workspace-context';
import { getCurrentWorkspace } from '@/lib/workspace/current-workspace';

/**
 * The application shell's layout: every page under `(app)` renders inside
 * `<AppShell>`, with the current workspace in context.
 *
 * The workspace is resolved on the server (a stub returning `null` until
 * subphase 0.3) and handed to the client provider as a plain serializable
 * value. With `null` every piece of chrome renders its signed-out state.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
    const workspace = await getCurrentWorkspace();
    return (
        <WorkspaceProvider value={workspace}>
            <AppShell>{children}</AppShell>
        </WorkspaceProvider>
    );
}
