'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/** Rendered only when the server says the Google provider is configured. */
export function GoogleButton({ callbackUrl }: { callbackUrl: string }) {
    const t = useTranslations('auth');
    return (
        <Button
            type="button"
            variant="secondary"
            className="w-full"
            id="google-sign-in"
            onClick={() => void signIn('google', { callbackUrl })}
            text={t('continueWithGoogle')}
        />
    );
}
