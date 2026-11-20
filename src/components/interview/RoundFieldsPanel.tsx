'use client';

/**
 * The side panel of an interview (Phase 2.4): the bible fields the round
 * targets, filling as answers arrive. Nothing is written to the bible here —
 * proposals arrive with enrichment (2.5) — so an answered field reads "pending
 * enrichment", with the answer beside it, read-only.
 *
 * Once a round closes its answers are reconciled into proposed changes (2.5):
 * `reviewHref` links to the interview's review, where the author accepts them.
 *
 * Before the round is committed it lists the fields the round PLANNED (the
 * stream's `planned` event: ids and keys), all waiting; once committed, the
 * round's own questions decide each field's state.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import type { QuestionView } from '@/lib/interview/api-client';
import type { PlannedField } from '@/lib/interview/stream-events';

export interface FieldNaming {
    elementName: (elementId: string) => string;
    fieldLabel: (elementId: string, fieldKey: string) => string;
}

type FieldState = 'waiting' | 'pending' | 'skipped' | 'deferred';

interface Row {
    key: string;
    elementId: string;
    fieldKey: string;
    state: FieldState;
    challenge: boolean;
    answer: string | null;
}

function answerText(q: QuestionView): string | null {
    const a = q.answer;
    if (a?.status !== 'ANSWERED') return null;
    return [a.choice, a.scale === null ? null : String(a.scale), a.text].filter((x): x is string => x !== null && x !== '').join(' — ') || null;
}

/** The panel's rows: one per (element, field), from the round's questions, else the plan's targets. Pure. */
export function panelRows(questions: readonly QuestionView[] | null, planned: readonly PlannedField[]): Row[] {
    const rows = new Map<string, Row>();
    if (questions && questions.length > 0) {
        for (const q of questions) {
            const status = q.answer?.status ?? null;
            const state: FieldState = status === 'ANSWERED' ? 'pending' : status === 'SKIPPED' ? 'skipped' : status === 'DECIDE_LATER' ? 'deferred' : 'waiting';
            for (const fieldKey of q.targetsFieldKeys) {
                const key = `${q.elementId}\u0000${fieldKey}`;
                rows.set(key, { key, elementId: q.elementId, fieldKey, state, challenge: q.mode === 'CHALLENGE', answer: answerText(q) });
            }
        }
        return [...rows.values()];
    }
    for (const p of planned) {
        const key = `${p.elementId}\u0000${p.fieldKey}`;
        if (!rows.has(key)) rows.set(key, { key, elementId: p.elementId, fieldKey: p.fieldKey, state: 'waiting', challenge: false, answer: null });
    }
    return [...rows.values()];
}

export function RoundFieldsPanel({
    questions,
    planned,
    naming,
    reviewHref = null,
}: {
    questions: readonly QuestionView[] | null;
    planned: readonly PlannedField[];
    naming: FieldNaming;
    /** The interview's review of proposed changes (Phase 2.5): where pending enrichment goes once a round closes. */
    reviewHref?: string | null;
}) {
    const t = useTranslations('interview.panel');
    const rows = panelRows(questions, planned);
    return (
        <Card className="space-y-default p-5" data-testid="round-fields" aria-labelledby="round-fields-title">
            <div className="space-y-tight">
                <h2 id="round-fields-title" className="text-base font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                <p className="text-xs text-content-muted">{t('description')}</p>
            </div>
            {rows.length === 0 ? (
                <p className="text-sm text-content-muted">{t('empty')}</p>
            ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                    {rows.map((r) => (
                        <li key={r.key} className="space-y-1 py-2" data-testid="round-field" data-state={r.state}>
                            <div className="flex items-start justify-between gap-tight">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-content-emphasis">{naming.fieldLabel(r.elementId, r.fieldKey)}</p>
                                    <p className="truncate text-xs text-content-muted">{naming.elementName(r.elementId)}</p>
                                </div>
                                <StatusBadge variant={r.state === 'pending' ? 'success' : 'neutral'}>
                                    {r.state === 'pending' ? t('pending') : r.state === 'skipped' ? t('skipped') : r.state === 'deferred' ? t('deferred') : r.challenge ? t('challenge') : t('waiting')}
                                </StatusBadge>
                            </div>
                            {r.answer ? <p className="whitespace-pre-wrap text-sm text-content-default">{r.answer}</p> : null}
                        </li>
                    ))}
                </ul>
            )}
            {reviewHref ? (
                <Link href={reviewHref} className="inline-block text-sm font-medium text-content-emphasis hover:underline" id="review-proposals">
                    {t('review')}
                </Link>
            ) : null}
        </Card>
    );
}
