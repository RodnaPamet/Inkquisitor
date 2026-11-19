import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { getSessionUser } from '@/app-layer/context';

export const metadata: Metadata = { title: 'Sign out — Inkquisitor' };
export const dynamic = 'force-dynamic';

/**
 * Sign out. A button, not a GET: signing out is a POST carrying next-auth's
 * CSRF token, so a link on another site cannot sign anybody out.
 */
export default async function SignOutPage() {
    if (!(await getSessionUser())) redirect('/login');
    const t = await getTranslations('auth.signout');
    const tc = await getTranslations('common');
    return (
        <AuthCard id="signout" title={t('title')} description={t('description', { app: tc('appName') })}>
            <SignOutButton />
        </AuthCard>
    );
}
