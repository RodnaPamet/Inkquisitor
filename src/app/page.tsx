import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/product';
import { firstWorkspaceSlug, getSessionUser } from '@/app-layer/context';

export const dynamic = 'force-dynamic';

/**
 * `/`: a signed-in person goes to their first workspace (oldest membership),
 * or to /no-workspace when they have none; a visitor sees the landing page
 * with Sign in and Sign up.
 */
export default async function HomePage() {
    const user = await getSessionUser();
    if (user) {
        const slug = await firstWorkspaceSlug(user.userId);
        redirect(slug ? `/w/${encodeURIComponent(slug)}` : '/no-workspace');
    }
    const t = await getTranslations('home');
    return (
        <main id="home" className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
            <h1 className="text-5xl font-bold tracking-tight">{PRODUCT_NAME}</h1>
            <p className="text-lg text-content-muted">{PRODUCT_DESCRIPTION}</p>
            <nav className="flex gap-default" aria-label={PRODUCT_NAME}>
                <Link href="/login" id="home-sign-in" className="font-medium text-content-emphasis underline">
                    {t('signIn')}
                </Link>
                <Link href="/signup" id="home-sign-up" className="font-medium text-content-emphasis underline">
                    {t('signUp')}
                </Link>
            </nav>
        </main>
    );
}
