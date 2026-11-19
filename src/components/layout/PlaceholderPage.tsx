'use client';

/**
 * A top-level page that exists so the shell has somewhere to point, before
 * the feature behind it is built (Books, in Phase 1).
 *
 * Signed out (no workspace) it says so; inside a workspace it shows the
 * page's empty state. Built from the lifted `<PageHeader>` and
 * `<EmptyState>`, so the placeholder already sits in the real page rhythm.
 */

import { useTranslations } from 'next-intl';
import { BookOpen, type LucideIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { useOptionalWorkspace } from '@/lib/workspace/workspace-context';

// Chosen here, not passed in: the pages are server components, and a
// component (a function) cannot cross into a client component as a prop.
const ICONS: Record<PlaceholderPageName, LucideIcon> = { books: BookOpen };

export type PlaceholderPageName = 'books';

export function PlaceholderPage({ page }: { page: PlaceholderPageName }) {
    const icon = ICONS[page];
    const t = useTranslations(`pages.${page}`);
    const workspace = useOptionalWorkspace();
    return (
        <div className="space-y-section" data-testid={`placeholder-${page}`}>
            <PageHeader title={t('title')} description={t('description')} />
            <EmptyState icon={icon} title={workspace ? t('empty') : t('signedOut')} />
        </div>
    );
}
