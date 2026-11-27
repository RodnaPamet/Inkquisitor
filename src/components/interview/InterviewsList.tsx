'use client';

/**
 * A book's interviews (Phase 2.4): what each asked about, its status, its
 * rounds and why it stopped (the recorded reason, worded here), newest first.
 * Opening one resumes it on its own page. Every member reads the list
 * (`bible.view`); starting one is on the book and its entries.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MessagesSquare } from 'lucide-react';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns } from '@/components/ui/table';
import { formatDate } from '@inkquisitor/ui/lib/format-date';
import { APP_ROUTES } from '@/lib/app-routes';
import type { BibleKind } from '@/lib/bible/kinds';
import type { SessionSummaryView } from '@/lib/interview/api-client';
import { useStopMessage } from './messages';

export interface InterviewsListProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    sessions: SessionSummaryView[];
    truncated: boolean;
    kindLabels: Record<BibleKind, string>;
    /** Proposed bible changes still waiting for review, per session (Phase 2.5). */
    pendingBySession?: Readonly<Record<string, number>>;
}

export function InterviewsList({ workspaceSlug, book, sessions, truncated, kindLabels, pendingBySession = {} }: InterviewsListProps) {
    const t = useTranslations('interview.list');
    const tScope = useTranslations('interview.scope');
    const tStatus = useTranslations('interview.status');
    const stopMessage = useStopMessage();
    const router = useRouter();

    const columns = useMemo(
        () =>
            createColumns<SessionSummaryView>([
                {
                    id: 'scope',
                    header: t('colScope'),
                    cell: ({ row }) => {
                        const s = row.original;
                        const label =
                            s.scope === 'ELEMENT'
                                ? tScope('ELEMENT', { name: s.targetElementName ?? tScope('unknownElement') })
                                : s.scope === 'KIND' && s.targetKind
                                  ? tScope('KIND', { kind: kindLabels[s.targetKind] })
                                  : s.scope === 'SELECTION'
                                    ? tScope('SELECTION', { elements: s.scopeElementIds.length, relations: s.scopeRelationIds.length })
                                    : s.scope === 'BETWEEN'
                                      ? tScope('BETWEEN')
                                      : s.scope === 'SCENE'
                                        ? tScope('SCENE')
                                        : tScope('BOOK');
                        return (
                            <Link href={APP_ROUTES.interview(workspaceSlug, book.id, s.id)} className="font-medium text-content-emphasis hover:underline">
                                {label}
                            </Link>
                        );
                    },
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={row.original.status === 'ACTIVE' ? 'info' : row.original.status === 'PAUSED' ? 'warning' : 'neutral'}>{tStatus(row.original.status)}</StatusBadge>
                    ),
                },
                { id: 'rounds', header: t('colRounds'), cell: ({ row }) =>
                    row.original.length.mode === 'ROUNDS'
                        ? t('rounds', { run: row.original.roundsRun, budget: row.original.length.rounds })
                        : row.original.length.mode === 'QUESTIONS'
                          ? t('roundsQuestions', { run: row.original.roundsRun, questions: row.original.length.questions })
                          : t('roundsOpenEnded', { run: row.original.roundsRun }) },
                {
                    id: 'reason',
                    header: t('colReason'),
                    cell: ({ row }) => (row.original.stopReason ? <span className="text-sm text-content-default">{stopMessage(row.original.stopReason, row.original.stopDetail)}</span> : '—'),
                },
                {
                    id: 'proposals',
                    header: t('colProposals'),
                    cell: ({ row }) => {
                        const count = pendingBySession[row.original.id] ?? 0;
                        return count > 0 ? (
                            <Link
                                href={APP_ROUTES.interviewReview(workspaceSlug, book.id, row.original.id)}
                                className="text-sm font-medium text-content-emphasis hover:underline"
                                onClick={(e) => e.stopPropagation()}
                                data-testid="review-link"
                            >
                                {t('toReview', { count })}
                            </Link>
                        ) : (
                            '—'
                        );
                    },
                },
                { id: 'started', header: t('colStarted'), cell: ({ row }) => formatDate(row.original.createdAt) },
            ]),
        [t, tScope, tStatus, stopMessage, kindLabels, workspaceSlug, book.id, pendingBySession],
    );

    return (
        <EntityListPage<SessionSummaryView>
            header={{
                breadcrumbs: [
                    { label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) },
                    { label: t('title') },
                ],
                title: t('title'),
                description: truncated ? t('truncated', { count: sessions.length }) : t('description'),
            }}
            table={{
                data: sessions,
                columns,
                getRowId: (s) => s.id,
                onRowClick: (row) => router.push(APP_ROUTES.interview(workspaceSlug, book.id, row.original.id)),
                selectionEnabled: false,
                emptyState: <EmptyState icon={MessagesSquare} title={t('empty')} description={t('emptyHelp')} />,
                'data-testid': 'interviews-table',
            }}
        />
    );
}
