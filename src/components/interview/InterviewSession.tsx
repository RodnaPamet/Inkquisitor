'use client';

/**
 * The focused interview page (Phase 2.4): the current round's questions as
 * cards (`QuestionCard`), the fields they target beside them
 * (`RoundFieldsPanel`), and the session's state in plain words.
 *
 * A ROUND STREAMS IN. Starting an interview (`initial.kind === 'start'`, the
 * setup sheet's query) and every next round go through the streamed routes
 * (`useInterviewStream`): the page says what it is doing (choosing fields,
 * wording, checking), lists the planned fields at once, and shows each
 * validated question as a read-only DRAFT; the committed round replaces the
 * drafts, and only then can a question be answered. Cancel stops the stream:
 * the server abandons the round and frees the model call, nothing of it is
 * asked, and the session can continue later. A new session's id arrives first
 * (`started`), and the address becomes the session's own at once, so a reload
 * resumes it rather than starting another.
 *
 * RESUMABLE AND AUTOSAVED: every answer is saved as it is given (the cards);
 * the page reads the session as stored, so it resumes where the author left
 * it. Finishing a round closes it (optionally skipping what is left) and goes
 * straight on to the next, unless the session ends. The author can STOP at any
 * time and keep every answer. A stop or a pause is shown as the reason the
 * server recorded, worded here (`useStopMessage`); a session that asked
 * nothing reads "not assessed" (rule 6), never a percentage.
 *
 * `canEdit` is the server's `bible.edit`: a reader sees the interview as text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Square } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError, reasonOf } from '@/lib/bible/api-client';
import type { BibleKind } from '@/lib/bible/kinds';
import { INTERVIEW_API, interviewApi, type InterviewIds, type InterviewView, type QuestionView } from '@/lib/interview/api-client';
import { startRequestBody, type InterviewSetup, type InterviewTarget } from '@/lib/interview/setup';
import type { DraftQuestion } from '@/lib/interview/stream-events';
import { isPersonaKey } from '@/lib/interview/vocabulary';
import type { ReconcileAttention } from '@/app-layer/usecases/enrichment-review';
import { useInterviewErrorMessage, useStopMessage } from './messages';
import { QuestionCard, type QuestionCardHandle } from './QuestionCard';
import { RoundFieldsPanel, type FieldNaming } from './RoundFieldsPanel';
import { useInterviewStream } from './use-interview-stream';

export interface ScopeElement {
    id: string;
    name: string;
    kind: BibleKind;
}

export interface InterviewSessionProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    canEdit: boolean;
    /** The elements the interview may ask about, for naming them. */
    elements: ScopeElement[];
    /** Field labels by kind (template product text). */
    fieldLabels: Partial<Record<BibleKind, Record<string, string>>>;
    kindLabels: Record<BibleKind, string>;
    initial: { kind: 'existing'; interview: InterviewView } | { kind: 'start'; target: InterviewTarget; setup: InterviewSetup };
    /**
     * Rounds whose reconcile failed or was refused when the page was read
     * (issue #39 item 6), with the outcome: their answers wait, proposing
     * nothing, until the review page runs them again — except a TOKEN_BUDGET
     * refusal, which running again cannot help, and which is worded so.
     */
    reconcileAttention?: readonly ReconcileAttention[];
}

export function InterviewSession(props: InterviewSessionProps) {
    const { workspaceSlug, book, canEdit, elements, fieldLabels, kindLabels, initial } = props;
    const [reconcileAttention, setReconcileAttention] = useState<readonly ReconcileAttention[]>(props.reconcileAttention ?? []);
    const t = useTranslations('interview.session');
    const tStatus = useTranslations('interview.status');
    const tPersona = useTranslations('interview.personas');
    const tScope = useTranslations('interview.scope');
    const stopMessage = useStopMessage();
    const errorMessage = useInterviewErrorMessage(kindLabels);
    const stream = useInterviewStream();

    const [view, setView] = useState<InterviewView | null>(initial.kind === 'existing' ? initial.interview : null);
    const [sessionId, setSessionId] = useState<string | null>(initial.kind === 'existing' ? initial.interview.session.id : null);
    const [closing, setClosing] = useState(false);
    const [stopOpen, setStopOpen] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const cardRefs = useRef(new Map<string, QuestionCardHandle | null>());

    const byId = useMemo(() => new Map(elements.map((e) => [e.id, e] as const)), [elements]);
    const naming: FieldNaming = useMemo(
        () => ({
            elementName: (id) => byId.get(id)?.name ?? tScope('unknownElement'),
            fieldLabel: (id, key) => {
                const kind = byId.get(id)?.kind;
                return (kind && fieldLabels[kind]?.[key]) ?? key;
            },
        }),
        [byId, fieldLabels, tScope],
    );

    const ids: InterviewIds | null = sessionId ? { slug: workspaceSlug, bookId: book.id, sessionId } : null;

    const refresh = useCallback(
        async (id: string) => {
            try {
                const { interview } = await interviewApi.get({ slug: workspaceSlug, bookId: book.id, sessionId: id });
                setView(interview);
            } catch {
                // The page keeps what it has; the next action reads again.
            }
        },
        [workspaceSlug, book.id],
    );

    /** Run one streamed round (or the start), then take the interview as stored. */
    const runStream = useCallback(
        async (url: string, body: unknown, knownSessionId: string | null) => {
            setNotice(null);
            const final = await stream.run(url, body, (event) => {
                // A new session's own address, as soon as its row exists: a reload resumes it.
                if (event.type !== 'started') return;
                setSessionId(event.sessionId);
                window.history.replaceState(null, '', APP_ROUTES.interview(workspaceSlug, book.id, event.sessionId));
            });
            if (final.committed) {
                setView(final.committed);
                return;
            }
            const id = final.sessionId ?? knownSessionId;
            if (id) await refresh(id);
        },
        [stream, refresh, workspaceSlug, book.id],
    );

    // ── The start (from the setup sheet): once, cancelled only when the page truly goes away ──
    const started = useRef(false);
    const pendingCancel = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (pendingCancel.current) clearTimeout(pendingCancel.current);
        pendingCancel.current = null;
        if (initial.kind === 'start' && !started.current) {
            started.current = true;
            void runStream(INTERVIEW_API.startStream(workspaceSlug, book.id), startRequestBody(initial.target, initial.setup), null);
        }
        // Deferred: React's development double-mount runs this cleanup and the
        // effect again at once, and must not cancel the stream it just began.
        const cancel = stream.cancel;
        return () => {
            pendingCancel.current = setTimeout(cancel, 0);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Focus the first unanswered question when a round arrives.
    const roundId = view?.round?.status === 'OPEN' ? view.round.id : null;
    useEffect(() => {
        if (!roundId || !canEdit) return;
        const first = view?.round?.questions.find((q) => q.answer === null);
        if (first) cardRefs.current.get(first.id)?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roundId]);

    const session = view?.session ?? null;
    const round = view?.round ?? null;
    // A session from before pack pinning (2.2) can never resume (issue #36,
    // item 2): the server ends it on its next round, and a row still paused
    // from before that is shown as ended too — never offered "Continue".
    const unpinned = session?.stopReason === 'PACK_CHANGED' && (session.stopDetail as { problem?: unknown } | null)?.problem === 'PACK_NOT_PINNED';
    const ended = session?.status === 'COMPLETED' || session?.status === 'STOPPED' || unpinned;
    const roundOpen = round?.status === 'OPEN' && session?.status === 'ACTIVE';
    const questions = roundOpen || round?.status === 'CLOSED' ? (round?.questions ?? []) : [];
    const unanswered = roundOpen ? questions.filter((q) => q.answer === null).length : 0;
    const streaming = stream.busy;

    /** A question's new state (an answer, a rephrase), and the session's figure moved with it. */
    function replaceQuestion(updated: QuestionView, replacedId = updated.id) {
        setView((v) => {
            if (!v || !v.round) return v;
            const before = v.round.questions.find((q) => q.id === replacedId);
            return { ...v, progress: progressAfter(v.progress, before?.answer?.status ?? null, updated.answer?.status ?? null), round: { ...v.round, questions: v.round.questions.map((q) => (q.id === replacedId ? updated : q)) } };
        });
    }

    async function nextRound() {
        if (!ids) return;
        await runStream(INTERVIEW_API.nextRoundStream(ids.slug, ids.bookId, ids.sessionId), {}, ids.sessionId);
    }

    /**
     * Every card's unsaved answer saved, and every save settled, before a
     * close or a stop: either could otherwise overtake an answer on its way (a
     * close skipping it, a stop refusing it) and lose it. Null when a save
     * failed: the answer is still only on screen, so nothing goes on.
     */
    async function flushAnswers(): Promise<{ open: number } | null> {
        const results = await Promise.all(questions.map((q) => cardRefs.current.get(q.id)?.flush() ?? Promise.resolve(q.answer ? ('answered' as const) : ('open' as const))));
        if (results.includes('unsaved')) {
            toast.error(t('unsavedHold'));
            return null;
        }
        return { open: results.filter((r) => r === 'open').length };
    }

    /** Keep the list of rounds whose reconcile did not run to its end in step with the runs just made. */
    function noteReconcileRuns(runs: ReadonlyArray<{ roundNumber: number; status: string; outcome: string | null }>) {
        if (runs.length === 0) return;
        setReconcileAttention((before) => {
            const next = new Map(before.map((r) => [r.roundNumber, r.outcome] as const));
            for (const r of runs) {
                if (r.status === 'FAILED' || r.status === 'REFUSED') next.set(r.roundNumber, r.outcome);
                else next.delete(r.roundNumber);
            }
            return [...next.entries()].sort(([a], [b]) => a - b).map(([roundNumber, outcome]) => ({ roundNumber, outcome }));
        });
    }
    // A round refused for the session's token budget cannot be helped by running it again.
    const rerunnableRounds = reconcileAttention.filter((r) => r.outcome !== 'TOKEN_BUDGET').map((r) => r.roundNumber);
    const budgetSpentRounds = reconcileAttention.filter((r) => r.outcome === 'TOKEN_BUDGET').map((r) => r.roundNumber);

    async function finishRound() {
        if (!ids || !round) return;
        setClosing(true);
        try {
            const flushed = await flushAnswers();
            if (!flushed) return;
            // "Skip the rest" only for what is still unanswered once every save has landed.
            const { interview, reconcile } = await interviewApi.closeRound(ids, round.number, flushed.open > 0);
            setView(interview);
            // Phase 2.5: the closed round's answers were reconciled into proposed changes.
            if (reconcile?.status === 'DONE') {
                const p = reconcile.proposed;
                setNotice(t('reconciled', { count: p.ADD + p.UPDATE + p.REMOVE + p.NEW_ELEMENT }));
            }
            noteReconcileRuns(reconcile ? [reconcile] : []);
            // Straight on to the next round, unless the session ended.
            if (interview.session.status === 'ACTIVE') await runStream(INTERVIEW_API.nextRoundStream(ids.slug, ids.bookId, ids.sessionId), {}, ids.sessionId);
        } catch (err) {
            toast.error(errorMessage(reasonOf(err), statusOf(err), err instanceof BibleApiError ? err.details : undefined));
        } finally {
            setClosing(false);
        }
    }

    async function stop() {
        if (!ids) return;
        setStopping(true);
        try {
            if (stream.busy) stream.cancel();
            if (roundOpen && !(await flushAnswers())) return;
            const { interview, reconcile } = await interviewApi.stop(ids);
            setView(interview);
            noteReconcileRuns(reconcile ?? []);
            setStopOpen(false);
            setNotice(t('stopped'));
        } catch (err) {
            toast.error(errorMessage(reasonOf(err), statusOf(err), err instanceof BibleApiError ? err.details : undefined));
        } finally {
            setStopping(false);
        }
    }

    // ── Titles ──
    const scope = session?.scope ?? (initial.kind === 'start' ? initial.target.scope : 'BOOK');
    const targetElementId = session?.targetElementId ?? (initial.kind === 'start' && initial.target.scope === 'ELEMENT' ? initial.target.elementId : null);
    const targetKind = session?.targetKind ?? (initial.kind === 'start' && initial.target.scope === 'KIND' ? initial.target.kind : null);
    const title =
        scope === 'ELEMENT'
            ? t('titleElement', { name: (targetElementId && byId.get(targetElementId)?.name) || tScope('unknownElement') })
            : scope === 'KIND' && targetKind
              ? t('titleKind', { kind: kindLabels[targetKind] })
              : t('titleBook');

    const progress = view?.progress;
    const progressText = !progress || progress.status === 'NOT_ASSESSED' ? t('progressNotAssessed') : t('progress', { answered: progress.answered, asked: progress.asked });

    const s = stream.state;
    const phaseText =
        s.phase === 'connecting'
            ? t('connecting')
            : s.phase === 'planning'
              ? t('planning')
              : s.phase === 'thinking'
                ? s.call && s.call.of > 1
                    ? t('thinkingOf', { n: s.call.n, of: s.call.of })
                    : t('thinking')
                : s.phase === 'checking'
                  ? t('checking')
                  : null;

    const personaName = (key: string | null) => (key && isPersonaKey(key) ? tPersona(`${key}.name`) : null);
    const about = (q: { elementId: string; targetsFieldKeys: readonly string[] }) =>
        `${naming.elementName(q.elementId)} · ${q.targetsFieldKeys.map((k) => naming.fieldLabel(q.elementId, k)).join(', ')}`;

    const streamError = s.phase === 'done' && s.error ? errorMessage(s.error.reason, s.error.status, s.error.details) : null;
    const streamRefusal = s.phase === 'done' && s.refusal ? errorMessage(s.refusal) : null;

    return (
        <EntityDetailLayout
            id="interview-session"
            breadcrumbs={[
                { label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) },
                { label: t('breadcrumbInterviews'), href: APP_ROUTES.interviews(workspaceSlug, book.id) },
                { label: title },
            ]}
            title={title}
            meta={
                <div className="flex flex-wrap items-center gap-tight">
                    {session ? (
                        <StatusBadge variant={session.status === 'ACTIVE' ? 'info' : session.status === 'PAUSED' ? 'warning' : 'neutral'} data-testid="session-status">
                            {tStatus(session.status)}
                        </StatusBadge>
                    ) : null}
                    {round && session ? <span className="text-xs text-content-muted">{t('roundOf', { number: round.number, budget: session.roundBudget })}</span> : null}
                    <span className="text-xs text-content-muted" aria-label={t('progressAria')} data-testid="session-progress">
                        {progressText}
                    </span>
                </div>
            }
            actions={
                canEdit && session && !ended ? (
                    <Button variant="secondary" icon={<Square className="size-4" aria-hidden="true" />} onClick={() => setStopOpen(true)} id="interview-stop">
                        {t('stop')}
                    </Button>
                ) : null
            }
            rail={
                <div className="xl:w-80">
                    <RoundFieldsPanel
                        questions={streaming || s.drafts.length > 0 ? null : questions}
                        planned={s.targets}
                        naming={naming}
                        reviewHref={sessionId ? APP_ROUTES.interviewReview(workspaceSlug, book.id, sessionId) : null}
                    />
                </div>
            }
        >
            {!canEdit ? <p className="text-sm text-content-muted">{t('readOnly')}</p> : null}
            {view?.scopeTruncated ? <p className="text-sm text-content-warning">{t('scopeTruncated')}</p> : null}

            {/* What the session is doing, said: a silent pause reads as a hang. */}
            <div role="status" aria-live="polite" className="space-y-tight" data-testid="interview-status">
                {phaseText ? (
                    <div className="flex flex-wrap items-center gap-tight rounded-lg border border-border-subtle bg-bg-muted p-3" data-testid="stream-progress" data-phase={s.phase}>
                        <span className="text-sm text-content-default">{phaseText}</span>
                        <Button variant="secondary" size="sm" className="ml-auto" onClick={stream.cancel} id="stream-cancel">
                            {t('cancel')}
                        </Button>
                    </div>
                ) : null}
                {s.phase === 'done' && s.stopped ? <p className="text-sm text-content-default" data-testid="stream-cancelled">{t('cancelled')}</p> : null}
                {streamError || streamRefusal ? (
                    <p className="text-sm text-content-error" role="alert" data-testid="stream-error">
                        {streamError ?? streamRefusal}
                    </p>
                ) : null}
                {s.phase === 'done' && s.connectionClosed && !s.stopped && !s.error && !s.refusal ? (
                    <p className="text-sm text-content-warning">{t('connectionClosed')}</p>
                ) : null}
                {notice ? <p className="text-sm text-content-default">{notice}</p> : null}
                {rerunnableRounds.length > 0 && sessionId ? (
                    <p className="rounded-lg border border-border-default bg-bg-subtle p-3 text-sm text-content-default" role="status" data-testid="reconcile-attention">
                        {t('reconcileNotRun', { count: rerunnableRounds.length, rounds: rerunnableRounds.join(', ') })}{' '}
                        <Link className="text-content-emphasis underline" href={APP_ROUTES.interviewReview(workspaceSlug, book.id, sessionId)}>
                            {t('reconcileNotRunLink')}
                        </Link>
                    </p>
                ) : null}
                {budgetSpentRounds.length > 0 ? (
                    <p className="rounded-lg border border-border-default bg-bg-subtle p-3 text-sm text-content-default" role="status" data-testid="reconcile-budget-spent">
                        {t('reconcileBudgetSpent', { count: budgetSpentRounds.length, rounds: budgetSpentRounds.join(', ') })}
                    </p>
                ) : null}
                {session && session.status !== 'ACTIVE' && session.stopReason && !streaming ? (
                    <p className="rounded-lg border border-border-default bg-bg-subtle p-3 text-sm text-content-default" data-testid="stop-reason" data-reason={session.stopReason}>
                        {stopMessage(session.stopReason, session.stopDetail)}
                    </p>
                ) : null}
                {view?.generatingRound && !streaming ? (
                    <div className="flex items-center gap-tight text-sm text-content-muted">
                        <span>{t('generatingElsewhere', { number: view.generatingRound })}</span>
                        {sessionId ? (
                            <Button variant="secondary" size="sm" onClick={() => void refresh(sessionId)}>
                                {t('reload')}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
            </div>

            {!view && !streaming && initial.kind === 'start' && (s.error || s.refusal) ? (
                <Link href={APP_ROUTES.book(workspaceSlug, book.id)} className="text-sm text-content-emphasis underline">
                    {t('backToBook')}
                </Link>
            ) : null}

            {s.drafts.length > 0 ? (
                <div className="space-y-default" data-testid="drafts">
                    <p className="text-xs text-content-muted">{t('draftNote')}</p>
                    {s.drafts.map((d, i) => (
                        <DraftCard key={d.draftId} draft={d.question} number={i + 1} about={about(d.question)} personaName={personaName(d.question.personaKey)} />
                    ))}
                </div>
            ) : null}

            {!streaming && questions.length > 0 && ids ? (
                <div className="space-y-default" data-testid="round-questions" data-round={round?.number}>
                    {questions.map((q, i) => (
                        <QuestionCard
                            key={q.id}
                            ref={(h) => void cardRefs.current.set(q.id, h)}
                            ids={ids}
                            question={q}
                            number={i + 1}
                            about={about(q)}
                            personaName={personaName(q.personaKey)}
                            canEdit={canEdit}
                            answerable={roundOpen}
                            onChanged={(updated) => replaceQuestion(updated)}
                            onRephrased={(replacement, replacedId) => {
                                replaceQuestion(replacement, replacedId);
                                setTimeout(() => cardRefs.current.get(replacement.id)?.focus(), 0);
                            }}
                            onAdvance={() => {
                                const next = questions.slice(i + 1).find((x) => x.answer === null) ?? questions[i + 1];
                                if (next) cardRefs.current.get(next.id)?.focus();
                                else document.getElementById('round-finish')?.focus();
                            }}
                        />
                    ))}
                </div>
            ) : null}

            {canEdit && !streaming && session && ids ? (
                <Card className="flex flex-wrap items-center gap-tight p-4" data-testid="round-controls">
                    {roundOpen ? (
                        <>
                            {unanswered > 0 ? <span className="text-sm text-content-muted">{t('unansweredLeft', { count: unanswered })}</span> : null}
                            <Button
                                variant={unanswered === 0 ? 'primary' : 'secondary'}
                                className="ml-auto"
                                onClick={() => void finishRound()}
                                loading={closing}
                                id="round-finish"
                            >
                                {unanswered > 0 ? t('closeRoundSkipRest') : t('closeRound')}
                            </Button>
                        </>
                    ) : !ended && !view?.generatingRound ? (
                        <Button variant="primary" onClick={() => void nextRound()} id="round-next">
                            {session.status === 'PAUSED' ? t('continue') : t('nextRound')}
                        </Button>
                    ) : ended ? (
                        <Link href={APP_ROUTES.book(workspaceSlug, book.id)} className="text-sm text-content-emphasis underline">
                            {t('backToBook')}
                        </Link>
                    ) : null}
                </Card>
            ) : null}

            {canEdit ? (
                <Modal showModal={stopOpen} setShowModal={setStopOpen} title={t('stopConfirmTitle')}>
                    <Modal.Header title={t('stopConfirmTitle')} description={t('stopConfirmBody')} />
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setStopOpen(false)}>
                            {t('stopKeep')}
                        </Button>
                        <Button variant="primary" onClick={() => void stop()} loading={stopping} id="interview-stop-confirm">
                            {t('stopConfirm')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            ) : null}
        </EntityDetailLayout>
    );
}

const statusOf = (err: unknown) => (err instanceof BibleApiError ? err.status : undefined);

type Progress = InterviewView['progress'];
type Status = NonNullable<QuestionView['answer']>['status'] | null;

/** The session's figure after one question moved from one answer status to another. Pure. */
export function progressAfter(p: Progress, from: Status, to: Status): Progress {
    if (p.status !== 'MEASURED' || from === to) return p;
    const key = (s: Status) => (s === 'ANSWERED' ? 'answered' : s === 'SKIPPED' ? 'skipped' : s === 'DECIDE_LATER' ? 'deferred' : 'unanswered');
    const next = { ...p, [key(from)]: p[key(from)] - 1, [key(to)]: p[key(to)] + 1 };
    return { ...next, answeredShare: next.answered / next.asked };
}

/** A question being prepared: read-only, no id, no control (it may still be dropped or renumbered). */
function DraftCard({ draft, number, about, personaName }: { draft: DraftQuestion; number: number; about: string; personaName: string | null }) {
    const t = useTranslations('interview.card');
    const tKind = useTranslations('interview.kinds');
    return (
        <Card className="space-y-tight border-dashed p-5 opacity-80" data-testid="draft-card" aria-busy="true">
            <div className="flex flex-wrap items-center gap-tight text-xs text-content-muted">
                <span className="font-semibold text-content-emphasis">{t('question', { number })}</span>
                <StatusBadge variant="info">{tKind(draft.kind)}</StatusBadge>
                <StatusBadge variant="neutral">{t('draft')}</StatusBadge>
                {draft.reviewRequired ? <StatusBadge variant="warning">{t('reviewRequired')}</StatusBadge> : null}
                {personaName ? <span>{t('persona', { name: personaName })}</span> : null}
            </div>
            <p className="text-xs text-content-muted">{about}</p>
            <p className="whitespace-pre-wrap text-base text-content-emphasis">{draft.text}</p>
            {draft.options ? (
                <ul className="list-inside list-decimal text-sm text-content-default">
                    {draft.options.map((o) => (
                        <li key={o}>{o}</li>
                    ))}
                </ul>
            ) : null}
        </Card>
    );
}
