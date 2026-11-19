'use client';

/**
 * The sign-up form: POST /api/auth/register creates the account and its
 * workspace, then the form signs in through the Credentials provider and
 * lands in the new workspace. A refusal's `details.reason` picks the message.
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
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-limits';

type ErrorState = { key: 'emailTaken' | 'passwordTooShort' | 'passwordTooLong' | 'passwordBreached' | 'invalidEmail' | 'rateLimited' | 'generic' };

const REASON_KEYS: Record<string, ErrorState['key']> = {
    EMAIL_ALREADY_REGISTERED: 'emailTaken',
    PASSWORD_EMPTY: 'passwordTooShort',
    PASSWORD_TOO_SHORT: 'passwordTooShort',
    PASSWORD_TOO_LONG: 'passwordTooLong',
    PASSWORD_BREACHED: 'passwordBreached',
};

async function refusalOf(res: Response): Promise<ErrorState> {
    if (res.status === 429) return { key: 'rateLimited' };
    try {
        const body = (await res.json()) as { error?: { code?: string; details?: { reason?: string } | unknown } };
        const reason = (body.error?.details as { reason?: string } | undefined)?.reason;
        if (reason && REASON_KEYS[reason]) return { key: REASON_KEYS[reason] };
        if (body.error?.code === 'VALIDATION_ERROR') return { key: 'invalidEmail' };
    } catch {
        // fall through
    }
    return { key: 'generic' };
}

export function SignUpForm() {
    const t = useTranslations('auth');
    const router = useRouter();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');
    const [error, setError] = useState<ErrorState | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError({ key: 'passwordTooShort' });
            return;
        }
        setPending(true);
        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    email,
                    password,
                    ...(name.trim() ? { name: name.trim() } : {}),
                    ...(workspaceName.trim() ? { workspaceName: workspaceName.trim() } : {}),
                }),
            });
            if (res.status !== 201) {
                setError(await refusalOf(res));
                setPending(false);
                return;
            }
            const { workspaceSlug } = (await res.json()) as { workspaceSlug: string };
            const target = `/w/${encodeURIComponent(workspaceSlug)}`;
            const result = await signIn('credentials', { email, password, redirect: false, callbackUrl: target });
            if (result && result.ok && !result.error) {
                router.replace(target);
                return;
            }
            router.replace('/login');
        } catch {
            setError({ key: 'generic' });
            setPending(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="space-y-default" noValidate id="signup-form">
            <FormField label={t('name')}>
                <Input id="signup-name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label={t('email')} required>
                <Input id="signup-email" type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
            <FormField label={t('password')} required description={t('passwordHint', { min: MIN_PASSWORD_LENGTH })}>
                <Input
                    id="signup-password"
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    maxLength={MAX_PASSWORD_LENGTH}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                />
            </FormField>
            <FormField label={t('workspaceName')} description={t('workspaceNameHint')}>
                <Input id="signup-workspace" name="workspaceName" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
            </FormField>
            {error ? (
                <FormError id="signup-error">{t(`errors.${error.key}`, { min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })}</FormError>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" loading={pending} id="signup-submit" text={t('signup.submit')} />
            <p className="text-sm text-content-muted">
                {t('signup.haveAccount')}{' '}
                <Link href="/login" className="font-medium text-content-emphasis underline">
                    {t('signup.toLogin')}
                </Link>
            </p>
        </form>
    );
}
