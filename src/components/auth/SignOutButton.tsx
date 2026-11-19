'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/** Signs this browser out (POST /api/auth/signout, which revokes its session row) and returns to sign-in. */
export function SignOutButton({ variant = 'primary', id = 'signout-submit' }: { variant?: 'primary' | 'secondary'; id?: string }) {
    const t = useTranslations('auth.signout');
    const [pending, setPending] = useState(false);
    return (
        <Button
            type="button"
            variant={variant}
            className="w-full"
            id={id}
            loading={pending}
            onClick={() => {
                setPending(true);
                void signOut({ callbackUrl: '/login' });
            }}
            text={t('submit')}
        />
    );
}
