import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { LoginForm } from '@/components/auth/LoginForm';
import { googleSignInEnabled } from '@/auth';
import { getSessionUser } from '@/app-layer/context';
import { postSignInPath } from '@/lib/auth/redirect-path';

export const metadata: Metadata = { title: 'Sign in — Inkquisitor' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** Sign in with email and password, or Google when it is configured. A signed-in visitor goes on. */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const callbackUrl = postSignInPath(first(params.callbackUrl));
    if (await getSessionUser()) redirect(callbackUrl);
    const t = await getTranslations('auth');
    const tc = await getTranslations('common');
    return (
        <AuthCard id="login" title={t('login.title')} description={t('login.description', { app: tc('appName') })}>
            {googleSignInEnabled() ? (
                <>
                    <GoogleButton callbackUrl={callbackUrl} />
                    <p className="text-center text-xs uppercase text-content-subtle">{t('or')}</p>
                </>
            ) : null}
            <LoginForm callbackUrl={callbackUrl} initialError={first(params.error)} />
        </AuthCard>
    );
}
