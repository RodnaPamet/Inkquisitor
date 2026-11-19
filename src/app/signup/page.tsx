import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { GoogleButton } from '@/components/auth/GoogleButton';
import { SignUpForm } from '@/components/auth/SignUpForm';
import { googleSignInEnabled } from '@/auth';
import { getSessionUser } from '@/app-layer/context';

export const metadata: Metadata = { title: 'Create an account — Inkquisitor' };
export const dynamic = 'force-dynamic';

/** Sign up: an account and a workspace of one's own (owner decision D4). */
export default async function SignUpPage() {
    if (await getSessionUser()) redirect('/');
    const t = await getTranslations('auth');
    return (
        <AuthCard id="signup" title={t('signup.title')} description={t('signup.description')}>
            {googleSignInEnabled() ? (
                <>
                    <GoogleButton callbackUrl="/" />
                    <p className="text-center text-xs uppercase text-content-subtle">{t('or')}</p>
                </>
            ) : null}
            <SignUpForm />
        </AuthCard>
    );
}
