'use client';

/**
 * `<AppShell>` with sign-out wired, for pages inside a workspace. A client
 * component because the sign-out handler is a function, which cannot cross
 * from the server layout into the shell as a prop.
 */
import type { ReactNode } from 'react';
import { signOut } from 'next-auth/react';
import { AppShell } from './AppShell';

export function WorkspaceAppShell({ children }: { children: ReactNode }) {
    return <AppShell onLogout={() => void signOut({ callbackUrl: '/login' })}>{children}</AppShell>;
}
