'use client';

/**
 * A book's Interrogate page (Phase 4.3, D29): book-level sessions over the
 * whole canon. Nothing here writes the bible (rule 1).
 *
 *   • THE STRESS TEST: what the next pass would read and leave out, its "at
 *     most" cost, and "Stress test this book" behind a confirmation naming that
 *     cost; the book's tests, newest first, polled while one runs; each weak
 *     point as its label, its QUESTIONS (never a verdict, never a rewrite) and
 *     what it cites; and "Start a session from these weak points". A book with
 *     nothing in it reads "not assessed" (rule 6).
 *   • THE GAP HUNT: the code's candidate gaps, ranked by the model when it can
 *     be (after the author confirms the call's "at most"), otherwise shown
 *     LABELLED UNRANKED with the reason; the next three sessions, each ready to
 *     start.
 *   • THE PANEL: the book questioned by Target Reader, Ruthless Editor and Genre
 *     Specialist together (the setup sheet's Panel preset, opened here).
 *
 * `canEdit` is `bible.edit`, passed down; a reader reads. Every text renders as
 * text; refusals are worded from their `details.reason`.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Play, Users } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { InterviewSetupSheet } from '@/components/interview/InterviewSetupSheet';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import type { ProposedSession } from '@/lib/gap-hunt/sessions';
import { CODE_SETUP_DEFAULTS, interviewSetupQuery } from '@/lib/interview/setup';
import { formatCost, interrogationApi, type GapHuntPage, type StressTestPage, type StressTestView } from '@/lib/interrogation/api-client';
import { isLiveStressTest } from '@/lib/stress-test/vocabulary';
import type { StressCoverage } from '@/lib/stress-test/input';

export interface InterrogatePageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    stress: StressTestPage;
    gaps: GapHuntPage;
    canEdit: boolean;
}

const POLL_MS = 3_000;

function useReasonText() {
    const reasons = useTranslations('interrogation.reasons');
    return (err: unknown) => {
        const reason = err instanceof BibleApiError ? err.reason : null;
        return reason && reasons.has(reason) ? reasons(reason) : reasons('generic');
    };
}

function CoverageLine({ coverage }: { coverage: StressCoverage }) {
    const t = useTranslations('interrogation.stress');
    return (
        <p className="text-sm text-content-muted" data-testid="stress-coverage">
            {t('coverage', {
                elements: coverage.elements.shown,
                elementsTotal: coverage.elements.total,
                facts: coverage.facts.shown,
                factsTotal: coverage.facts.total,
                threads: coverage.threads.shown,
                threadsTotal: coverage.threads.total,
                passages: coverage.passages.shown,
                passagesTotal: coverage.passages.total,
            })}
            {coverage.cut ? ` ${t('coverageCut')}` : ''}
        </p>
    );
}

function statusVariant(status: string): 'info' | 'success' | 'warning' | 'neutral' {
    if (isLiveStressTest(status)) return 'info';
    if (status === 'DONE') return 'success';
    return 'warning';
}

function StressTestCard({ test, workspaceSlug, bookId, canEdit, onChanged }: { test: StressTestView; workspaceSlug: string; bookId: string; canEdit: boolean; onChanged: (t: StressTestView) => void }) {
    const t = useTranslations('interrogation.stress');
    const live = isLiveStressTest(test.status);
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            interrogationApi
                .stressTest(workspaceSlug, bookId, test.id)
                .then((r) => onChanged(r.stressTest))
                .catch(() => undefined);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [live, workspaceSlug, bookId, test.id, onChanged]);
    const outcome = test.outcome ? (t.has(`outcome.${test.outcome}`) ? t(`outcome.${test.outcome}`) : t('outcome.generic')) : null;
    const session =
        canEdit && test.sessionElementIds.length > 0
            ? APP_ROUTES.newInterview(workspaceSlug, bookId, interviewSetupQuery({ scope: 'SELECTION', elementIds: test.sessionElementIds, relationIds: [], stressTestId: test.id }, { ...CODE_SETUP_DEFAULTS, personaKeys: [] }))
            : null;
    return (
        <Card className="space-y-default p-default" data-testid="stress-test" data-status={test.status} aria-label={t('testLabel', { when: new Date(test.createdAt).toLocaleString() })}>
            <div className="flex flex-wrap items-center justify-between gap-tight">
                <p className="text-sm text-content-muted">{t('when', { when: new Date(test.createdAt).toLocaleString() })}</p>
                <StatusBadge variant={statusVariant(test.status)}>{t(`status.${test.status}`)}</StatusBadge>
            </div>
            {live ? (
                <p className="text-sm text-content-muted" role="status" aria-live="polite">
                    {t('running')}
                </p>
            ) : null}
            {outcome ? <p className="text-sm text-content-default" data-testid="stress-outcome">{outcome}</p> : null}
            {test.coverage ? <CoverageLine coverage={test.coverage} /> : null}
            <p className="text-xs text-content-muted">{t('cost', { cost: formatCost(test.costMicroUsd), confirmed: formatCost(test.confirmedWorstMicroUsd) })}</p>
            {test.weakPoints.length > 0 ? (
                <ol className="space-y-default" aria-label={t('weakPointsTitle')}>
                    {test.weakPoints.map((w) => (
                        <li key={w.id} className="space-y-tight rounded-md border border-border-subtle p-default" data-testid="weak-point">
                            <div className="flex flex-wrap items-baseline gap-tight">
                                <span className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t(`kind.${w.kind}`)}</span>
                                <h3 className="text-sm font-semibold text-content-emphasis">{w.title}</h3>
                            </div>
                            {w.flags.includes('POSSIBLE_INSTRUCTION') ? <p className="text-xs text-content-muted">{t('flagged')}</p> : null}
                            <ul className="list-disc space-y-tight pl-6 text-sm text-content-default" aria-label={t('questions')}>
                                {w.questions.map((q) => (
                                    <li key={q}>{q}</li>
                                ))}
                            </ul>
                            <p className="text-xs text-content-muted" data-testid="weak-point-cites">
                                {t('cites')}{' '}
                                {w.citations.map((c, i) => (
                                    <span key={`${c.type}:${c.id}`}>
                                        {i > 0 ? '; ' : ''}
                                        {t(`citation.${c.type}`)}: {c.label ?? t('citationGone')}
                                    </span>
                                ))}
                            </p>
                        </li>
                    ))}
                </ol>
            ) : null}
            {session ? (
                <Link href={session} className={buttonVariants({ variant: 'primary' })} data-testid="stress-start-session">
                    {t('startSession')}
                </Link>
            ) : null}
        </Card>
    );
}

function sessionHref(workspaceSlug: string, bookId: string, s: ProposedSession): string {
    return APP_ROUTES.newInterview(workspaceSlug, bookId, interviewSetupQuery(s.target, { ...CODE_SETUP_DEFAULTS, personaKeys: [], depth: s.depth }));
}

export function InterrogatePage({ workspaceSlug, book, stress: initialStress, gaps: initialGaps, canEdit }: InterrogatePageProps) {
    const t = useTranslations('interrogation');
    const reasonText = useReasonText();
    const [stress, setStress] = useState(initialStress);
    const [gaps, setGaps] = useState(initialGaps);
    const [confirmStress, setConfirmStress] = useState(false);
    const [confirmGap, setConfirmGap] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const replaceTest = useCallback((next: StressTestView) => setStress((s) => ({ ...s, tests: s.tests.map((x) => (x.id === next.id ? next : x)) })), []);
    const liveTest = stress.tests.some((x) => isLiveStressTest(x.status));
    const estimate = stress.estimate;

    const startStress = async () => {
        if (!estimate) return;
        setBusy(true);
        try {
            const r = await interrogationApi.startStressTest(workspaceSlug, book.id, estimate.worstMicroUsd);
            setStress((s) => ({ ...s, tests: [r.stressTest, ...s.tests.filter((x) => x.id !== r.stressTest.id)] }));
            toast.success(t('stress.started'));
        } catch (err) {
            const details = err instanceof BibleApiError ? (err.details as { worstCaseMicroUsd?: number } | undefined) : undefined;
            if (err instanceof BibleApiError && err.reason === 'ESTIMATE_CHANGED' && details?.worstCaseMicroUsd !== undefined) {
                const worst = details.worstCaseMicroUsd;
                setStress((s) => ({ ...s, estimate: s.estimate ? { ...s.estimate, worstMicroUsd: worst } : s.estimate }));
            }
            toast.error(reasonText(err));
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const runGap = async (confirm: number | null) => {
        setBusy(true);
        try {
            const r = await interrogationApi.runGapHunt(workspaceSlug, book.id, confirm);
            setGaps((g) => ({ ...g, hunt: r.hunt }));
            toast.success(r.hunt.ranked ? t('gaps.ranked') : t('gaps.shownUnranked'));
        } catch (err) {
            const details = err instanceof BibleApiError ? (err.details as { worstCaseMicroUsd?: number } | undefined) : undefined;
            if (err instanceof BibleApiError && err.reason === 'ESTIMATE_CHANGED' && details?.worstCaseMicroUsd !== undefined) {
                const worst = details.worstCaseMicroUsd;
                setGaps((g) => ({ ...g, ranking: { available: true, worstMicroUsd: worst } }));
            }
            toast.error(reasonText(err));
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const hunt = gaps.hunt;
    const byN = new Map(hunt.candidates.map((c) => [c.n, c] as const));
    const unavailableText = stress.unavailable ? (t.has(`reasons.${stress.unavailable}`) ? t(`reasons.${stress.unavailable}`) : t('reasons.generic')) : null;
    const sessionName = (s: ProposedSession): string => {
        const c = byN.get(s.n);
        if (s.target.scope === 'ELEMENT') return t('gaps.sessionElement', { element: hunt.elementNames[s.target.elementId] ?? c?.kindLabel ?? '', field: c?.fieldLabel ?? '', depth: s.depth });
        return t('gaps.sessionKind', { kind: c?.kindLabel ?? '', field: c?.fieldLabel ?? '', depth: s.depth });
    };

    return (
        <EntityDetailLayout
            id="interrogate-page"
            breadcrumbs={[{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: t('title') }]}
            title={t('title')}
            meta={<span className="text-sm text-content-muted">{t('subtitle')}</span>}
            actions={
                canEdit ? (
                    <Button type="button" variant="secondary" icon={<Users className="size-4" />} onClick={() => setPanelOpen(true)} id="interrogate-panel">
                        {t('panel.open')}
                    </Button>
                ) : null
            }
        >
            <div className="space-y-section">
                <section className="space-y-default" aria-labelledby="stress-title" id="stress-test">
                    <h2 id="stress-title" className="text-base font-semibold text-content-emphasis">
                        {t('stress.title')}
                    </h2>
                    <p className="text-sm text-content-muted">{t('stress.help')}</p>
                    {!stress.assessed ? (
                        <EmptyState title={t('notAssessed')} description={t('stress.notAssessedHelp')} />
                    ) : (
                        <Card className="space-y-tight p-default" data-testid="stress-estimate">
                            {estimate?.coverage ? <CoverageLine coverage={estimate.coverage} /> : null}
                            {estimate ? (
                                <p className="text-sm text-content-default">{estimate.overBudget ? t('stress.overBudget') : t('stress.atMost', { worst: formatCost(estimate.worstMicroUsd) })}</p>
                            ) : null}
                            {unavailableText ? <p className="text-sm text-content-muted">{unavailableText}</p> : null}
                            {canEdit ? (
                                <div>
                                    <Button
                                        type="button"
                                        variant="primary"
                                        icon={<Play className="size-4" />}
                                        onClick={() => setConfirmStress(true)}
                                        disabled={busy || liveTest || !!stress.unavailable || !estimate || estimate.overBudget}
                                        id="stress-start"
                                    >
                                        {t('stress.start')}
                                    </Button>
                                </div>
                            ) : null}
                        </Card>
                    )}
                    {stress.tests.map((test) => (
                        <StressTestCard key={test.id} test={test} workspaceSlug={workspaceSlug} bookId={book.id} canEdit={canEdit} onChanged={replaceTest} />
                    ))}
                </section>

                <section className="space-y-default" aria-labelledby="gaps-title" id="gap-hunt">
                    <h2 id="gaps-title" className="text-base font-semibold text-content-emphasis">
                        {t('gaps.title')}
                    </h2>
                    <p className="text-sm text-content-muted">{t('gaps.help')}</p>
                    {!gaps.assessed ? (
                        <EmptyState title={t('notAssessed')} description={t('gaps.notAssessedHelp')} />
                    ) : hunt.candidates.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('gaps.none')}</p>
                    ) : (
                        <Card className="space-y-default p-default" data-testid="gap-hunt" data-ranked={hunt.ranked ? 'true' : 'false'}>
                            <div className="flex flex-wrap items-center gap-tight">
                                <StatusBadge variant={hunt.ranked ? 'success' : 'neutral'}>{hunt.ranked ? t('gaps.rankedBadge') : t('gaps.unrankedBadge')}</StatusBadge>
                                {!hunt.ranked && hunt.unrankedReason ? <span className="text-sm text-content-muted" data-testid="gap-unranked-reason">{t(`gaps.unranked.${hunt.unrankedReason}`)}</span> : null}
                                {hunt.changedSince ? <span className="text-sm text-content-muted">{t('gaps.changedSince')}</span> : null}
                            </div>
                            <ol className="space-y-tight" aria-label={t('gaps.picks')}>
                                {hunt.picks.map((p) => {
                                    const c = byN.get(p.n);
                                    if (!c) return null;
                                    return (
                                        <li key={p.n} className="space-y-tight" data-testid="gap-pick">
                                            <p className="text-sm font-medium text-content-emphasis">
                                                {c.kindLabel} › {c.fieldLabel}
                                            </p>
                                            <p className="text-xs text-content-muted">{t('gaps.counts', { empty: c.empty, elements: c.elements, dependents: c.dependents })}</p>
                                            {p.reason ? <p className="text-sm text-content-default">{p.reason}</p> : null}
                                            {p.flags.includes('POSSIBLE_INSTRUCTION') ? <p className="text-xs text-content-muted">{t('stress.flagged')}</p> : null}
                                        </li>
                                    );
                                })}
                            </ol>
                            {hunt.elementsCut ? <p className="text-xs text-content-muted">{t('gaps.elementsCut')}</p> : null}
                            {hunt.sessions.length > 0 ? (
                                <div className="space-y-tight">
                                    <h3 className="text-sm font-semibold text-content-emphasis">{t('gaps.nextSessions')}</h3>
                                    <ul className="flex flex-col gap-tight">
                                        {hunt.sessions.map((s) => (
                                            <li key={s.n}>
                                                {canEdit ? (
                                                    <Link href={sessionHref(workspaceSlug, book.id, s)} className="text-sm text-content-emphasis underline" data-testid="gap-session">
                                                        {sessionName(s)}
                                                    </Link>
                                                ) : (
                                                    <span className="text-sm text-content-default">{sessionName(s)}</span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                            {canEdit ? (
                                <div className="flex flex-wrap items-center gap-tight">
                                    {gaps.ranking.available ? (
                                        <Button type="button" variant="secondary" onClick={() => setConfirmGap(true)} disabled={busy} id="gap-rank">
                                            {t('gaps.rank', { worst: formatCost(gaps.ranking.worstMicroUsd) })}
                                        </Button>
                                    ) : (
                                        <>
                                            <span className="text-sm text-content-muted">{t(`gaps.unranked.${gaps.ranking.reason}`)}</span>
                                            <Button type="button" variant="secondary" onClick={() => void runGap(null).catch(() => undefined)} disabled={busy} id="gap-refresh">
                                                {t('gaps.refresh')}
                                            </Button>
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </Card>
                    )}
                </section>
            </div>
            {estimate ? (
                <Modal.Confirm
                    showModal={confirmStress}
                    setShowModal={setConfirmStress}
                    title={t('stress.confirmTitle')}
                    description={t('stress.confirmBody', { worst: formatCost(estimate.worstMicroUsd) })}
                    tone="info"
                    confirmLabel={t('stress.confirmLabel', { worst: formatCost(estimate.worstMicroUsd) })}
                    onConfirm={startStress}
                />
            ) : null}
            {gaps.ranking.available ? (
                <Modal.Confirm
                    showModal={confirmGap}
                    setShowModal={setConfirmGap}
                    title={t('gaps.confirmTitle')}
                    description={t('gaps.confirmBody', { worst: formatCost(gaps.ranking.worstMicroUsd) })}
                    tone="info"
                    confirmLabel={t('gaps.confirmLabel', { worst: formatCost(gaps.ranking.worstMicroUsd) })}
                    onConfirm={() => runGap(gaps.ranking.available ? gaps.ranking.worstMicroUsd : null)}
                />
            ) : null}
            {panelOpen ? <InterviewSetupSheet open={panelOpen} setOpen={setPanelOpen} workspaceSlug={workspaceSlug} bookId={book.id} target={{ scope: 'BOOK' }} title={t('panel.sheetTitle', { book: book.title })} /> : null}
        </EntityDetailLayout>
    );
}
