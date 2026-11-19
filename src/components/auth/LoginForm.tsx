'use client';

/**
 * The credentials sign-in form. Posts through next-auth's `signIn`, which
 * fetches the CSRF token and calls `/api/auth/callback/credentials`; on
 * success the router moves on to `callbackUrl`; every page there is
 * dynamic, so its server render reads the new session cookie.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FormError } from '@/components/ui/form-error';
import { signInErrorKey } from './sign-in-errors';

export function LoginForm({ callbackUrl, initialError }: { callbackUrl: string; initialError: string | null }) {
    const t = useTranslations('auth');
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(initialError);
    const [pending, setPending] = useState(false);
    const errorKey = signInErrorKey(error);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        try {
            const result = await signIn('credentials', { email, password, redirect: false, callbackUrl });
            if (result && result.ok && !result.error) {
                router.replace(callbackUrl);
                return;
            }
            setError(result?.error ?? 'generic');
        } catch {
            setError('generic');
        }
        setPending(false);
    }

    return (
        <form onSubmit={onSubmit} className="space-y-default" noValidate id="login-form">
            <FormField label={t('email')} required>
                <Input id="login-email" type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
            <FormField label={t('password')} required>
                <Input
                    id="login-password"
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </FormField>
            {errorKey ? <FormError id="login-error">{t(`errors.${errorKey}`)}</FormError> : null}
            <Button type="submit" variant="primary" className="w-full" loading={pending} id="login-submit" text={t('login.submit')} />
            <p className="text-sm text-content-muted">
                {t('login.noAccount')}{' '}
                <Link href="/signup" className="font-medium text-content-emphasis underline">
                    {t('login.toSignUp')}
                </Link>
            </p>
        </form>
    );
}
