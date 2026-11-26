'use client';

/**
 * One question of the open round (Phase 2.4), with the answer control its
 * kind takes:
 *
 *   OPEN       a text box
 *   SCENARIO   the scenario shown as a passage, then a text box
 *   CHOICE     its options (3 to 5), one to pick, and an optional reason
 *   EITHER_OR  its two options, one to pick, and an optional reason
 *   SCALE      1 to 5 with the meaning of each end, and an optional reason
 *
 * AUTOSAVED PER ANSWER, never in batches: a pick is sent the moment it is
 * made; written text when the author saves it (the button, Ctrl/⌘+Enter, or
 * Enter outside the box) or moves focus out of the card with it changed. One
 * request at a time per card; a pick made while one is in flight goes next.
 * Each save is the 2.2 answer route, so a re-answer is the next revision (at
 * most 20: the refusal is shown, ANSWER_REVISIONS_EXHAUSTED). A failed save
 * KEEPS what the author typed or picked and offers to try again.
 *
 * KEYBOARD FIRST, through `useKeyboardShortcut`, scoped to the card (`within`,
 * WCAG 2.1.4: a bare digit is never bound page-wide): 1–n pick an option or a
 * number (never while typing in a text box), Enter saves what is unsaved and
 * moves to the next question, Ctrl/⌘+Enter saves from inside the text box and
 * moves on.
 *
 * The recommendation is one click ("Use the suggestion"). Skip, Decide later
 * and "Ask me this differently" (a rephrase, which replaces the card) are the
 * other ways out. A question the guard flagged (`reviewRequired`) carries a
 * visible marker. A reader sees the question and its answer as text.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CornerDownRight, Repeat2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { useKeyboardShortcut } from '@/components/ui/hooks';
import { BibleApiError, reasonOf } from '@/lib/bible/api-client';
import { interviewApi, type AnswerBody, type InterviewIds, type QuestionView } from '@/lib/interview/api-client';
import { useInterviewErrorMessage } from './messages';

export interface QuestionCardHandle {
    /** Move focus into the card (its first control). */
    focus(): void;
    /**
     * Save what is typed or picked and not yet saved, and wait for every save
     * of this card to settle. Before the round is finished or the interview
     * stopped: a close (which may skip what is unanswered) or a stop must never
     * overtake an answer on its way. `answered`: the question holds an answer;
     * `open`: nothing to save and no answer; `unsaved`: a save failed, and the
     * answer is still only on the screen.
     */
    flush(): Promise<'answered' | 'open' | 'unsaved'>;
}

export interface QuestionCardProps {
    ids: InterviewIds;
    question: QuestionView;
    /** Its number as the author sees it, from 1. */
    number: number;
    /** What it asks about, as the side panel names it: "Aurel · Want". */
    about: string;
    personaName: string | null;
    canEdit: boolean;
    /** The round is open and the session active: the controls work. */
    answerable: boolean;
    onChanged: (question: QuestionView) => void;
    onRephrased: (replacement: QuestionView, replacedId: string) => void;
    /** Enter on a saved card: go to the next question. */
    onAdvance: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const isPick = (kind: QuestionView['kind']) => kind === 'CHOICE' || kind === 'EITHER_OR' || kind === 'SCALE';

function initialPick(q: QuestionView): string | number | null {
    if (q.answer?.status !== 'ANSWERED') return null;
    return q.kind === 'SCALE' ? q.answer.scale : q.answer.choice;
}

export const QuestionCard = forwardRef<QuestionCardHandle, QuestionCardProps>(function QuestionCard(props, ref) {
    const { ids, question: q, number, about, personaName, canEdit, answerable, onChanged, onRephrased, onAdvance } = props;
    const t = useTranslations('interview.card');
    const tKind = useTranslations('interview.kinds');
    const errorMessage = useInterviewErrorMessage();
    const cardRef = useRef<HTMLElement | null>(null);
    const firstControlRef = useRef<HTMLElement | null>(null);
    const editable = canEdit && answerable;

    const [pick, setPick] = useState<string | number | null>(() => initialPick(q));
    const [text, setText] = useState<string>(() => (q.answer?.status === 'ANSWERED' ? (q.answer.text ?? '') : ''));
    const [saved, setSaved] = useState<{ pick: string | number | null; text: string }>(() => ({ pick: initialPick(q), text: q.answer?.status === 'ANSWERED' ? (q.answer.text ?? '') : '' }));
    const [state, setState] = useState<SaveState>(q.answer ? 'saved' : 'idle');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<null | 'skip' | 'later' | 'rephrase' | 'accept'>(null);
    const inFlight = useRef(false);
    const queued = useRef<{ pick: string | number | null; text: string } | null>(null);
    /** The save running now (a queued one follows it): what `flush` waits for. */
    const active = useRef<Promise<void> | null>(null);
    /**
     * The same values as the state, kept current synchronously: `flush` runs
     * after awaits, before React has rendered what changed meanwhile.
     */
    const current = useRef({ pick, text });
    const savedNow = useRef(saved);
    const answeredNow = useRef(q.answer?.status === 'ANSWERED');
    /** What was on screen when the author skipped or deferred: kept, never saved by a flush. */
    const setAside = useRef<{ pick: string | number | null; text: string } | null>(null);
    // The answer whose save failed: kept, and offered again.
    const [failed, setFailed] = useState<{ pick: string | number | null; text: string } | null>(null);


    const options = q.kind === 'SCALE' ? ['1', '2', '3', '4', '5'] : (q.options ?? []);

    function bodyOf(v: { pick: string | number | null; text: string }): AnswerBody | null {
        const written = v.text.trim();
        if (q.kind === 'OPEN' || q.kind === 'SCENARIO') return written ? { text: v.text } : null;
        if (v.pick === null) return null;
        if (q.kind === 'SCALE') return { scale: Number(v.pick), ...(written ? { text: v.text } : {}) };
        return { choice: String(v.pick), ...(written ? { text: v.text } : {}) };
    }

    function send(v: { pick: string | number | null; text: string }): Promise<void> {
        const body = bodyOf(v);
        if (!body) return Promise.resolve();
        if (inFlight.current) {
            queued.current = v;
            return active.current ?? Promise.resolve();
        }
        inFlight.current = true;
        setState('saving');
        setError(null);
        setFailed(null);
        const run = (async () => {
            try {
                const { question } = await interviewApi.answer(ids, q.id, body);
                savedNow.current = v;
                answeredNow.current = true;
                setSaved(v);
                setState('saved');
                onChanged(question);
            } catch (err) {
                // The answer stays on screen, unsaved, with the reason and a retry.
                setState('error');
                setError(errorMessage(reasonOf(err), err instanceof BibleApiError ? err.status : undefined, err instanceof BibleApiError ? err.details : undefined));
                setFailed(v);
            } finally {
                inFlight.current = false;
                active.current = null;
                const next = queued.current;
                queued.current = null;
                if (next) void send(next);
            }
        })();
        active.current = run;
        return run;
    }

    const same = (a: { pick: string | number | null; text: string }, b: { pick: string | number | null; text: string } | null) => b !== null && a.pick === b.pick && a.text === b.text;
    /** Something on screen that a save would send, and that the author did not set aside with Skip or Decide later. */
    const pendingOf = (v: { pick: string | number | null; text: string }) => !same(v, savedNow.current) && !same(v, setAside.current) && bodyOf(v) !== null;

    const unsaved = pick !== saved.pick || text !== saved.text;
    const savable = editable && unsaved && bodyOf({ pick, text }) !== null;

    // Leaving the page with an answer typed and not yet saved asks first
    // (judged when the page is left, from the values on screen then).
    useEffect(() => {
        if (!editable) return;
        const warn = (e: BeforeUnloadEvent) => {
            if (!pendingOf(current.current)) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editable]);

    function choose(value: string | number) {
        if (!editable) return;
        setPick(value);
        current.current = { ...current.current, pick: value };
        // A pick is an answer: saved at once.
        void send({ pick: value, text: current.current.text });
    }

    function changeText(value: string) {
        setText(value);
        current.current = { ...current.current, text: value };
    }

    function saveNow() {
        if (savable) void send({ pick, text });
    }

    async function flush(): Promise<'answered' | 'open' | 'unsaved'> {
        if (!editable) return answeredNow.current ? 'answered' : 'open';
        if (pendingOf(current.current)) void send(current.current);
        while (active.current) await active.current;
        if (pendingOf(current.current)) return 'unsaved';
        return answeredNow.current ? 'answered' : 'open';
    }

    async function act(kind: 'skip' | 'later' | 'accept' | 'rephrase') {
        setBusy(kind);
        setError(null);
        try {
            if (kind === 'rephrase') {
                const { question } = await interviewApi.rephrase(ids, q.id);
                onRephrased(question, q.id);
                return;
            }
            const { question } =
                kind === 'skip' ? await interviewApi.skip(ids, q.id) : kind === 'later' ? await interviewApi.decideLater(ids, q.id) : await interviewApi.answer(ids, q.id, { acceptRecommendation: true });
            if (kind === 'accept' && question.answer) {
                const v = { pick: question.kind === 'SCALE' ? question.answer.scale : question.answer.choice, text: question.answer.text ?? '' };
                const shown = isPick(question.kind) ? v : { pick: null, text: v.text };
                setPick(shown.pick);
                setText(shown.text);
                current.current = shown;
                savedNow.current = shown;
                answeredNow.current = true;
                setSaved(shown);
                setState('saved');
            } else {
                // Skipped or deferred: what was typed stays, unsaved, in case
                // the author returns to it — but it is set aside, so finishing
                // the round never saves it over the author's skip.
                setAside.current = { ...current.current };
                savedNow.current = { pick: null, text: '' };
                answeredNow.current = false;
                setSaved({ pick: null, text: '' });
                setState('saved');
            }
            onChanged(question);
        } catch (err) {
            setError(errorMessage(reasonOf(err), err instanceof BibleApiError ? err.status : undefined, err instanceof BibleApiError ? err.details : undefined));
            if (kind !== 'rephrase') setState('error');
        } finally {
            setBusy(null);
        }
    }

    useImperativeHandle(ref, () => ({
        focus: () => (firstControlRef.current ?? cardRef.current)?.focus(),
        flush: () => flush(),
    }));

    // ── Keyboard ──
    const digits = options.map((_, i) => String(i + 1));
    useKeyboardShortcut(
        digits,
        (_e, { matched }) => {
            const i = Number(matched) - 1;
            if (q.kind === 'SCALE') choose(i + 1);
            else if (options[i] !== undefined) choose(options[i]);
        },
        { within: cardRef, enabled: editable && isPick(q.kind) && digits.length > 0, description: t('keys', { count: digits.length }) },
    );
    useKeyboardShortcut(
        'Enter',
        (e) => {
            // A focused button or link keeps its own Enter.
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'BUTTON' && target.getAttribute('role') !== 'radio')) return;
            if (target && target.tagName === 'A') return;
            e.preventDefault();
            if (savable) saveNow();
            onAdvance();
        },
        { within: cardRef, enabled: editable, preventDefault: false },
    );
    useKeyboardShortcut(
        'mod+Enter',
        () => {
            saveNow();
            onAdvance();
        },
        { within: cardRef, enabled: editable, allowInInputs: true, description: t('keysText') },
    );

    const status = q.answer?.status ?? null;
    const statusBadge =
        status === 'ANSWERED' ? (
            <StatusBadge variant="success">{q.answer?.acceptedRecommendation ? t('acceptedRecommendation') : t('answered')}</StatusBadge>
        ) : status === 'SKIPPED' ? (
            <StatusBadge variant="neutral">{t('skipped')}</StatusBadge>
        ) : status === 'DECIDE_LATER' ? (
            <StatusBadge variant="neutral">{t('deferred')}</StatusBadge>
        ) : (
            <StatusBadge variant="neutral">{t('unanswered')}</StatusBadge>
        );
    const headingId = `question-${q.id}-text`;

    return (
        <Card
            ref={cardRef as React.Ref<HTMLDivElement>}
            role="group"
            aria-labelledby={headingId}
            className="space-y-default p-5 focus-within:border-border-emphasis"
            data-testid="question-card"
            data-question-id={q.id}
            data-kind={q.kind}
            data-status={status ?? 'UNANSWERED'}
            tabIndex={-1}
        >
            <div className="flex flex-wrap items-center gap-tight text-xs text-content-muted">
                <span className="font-semibold text-content-emphasis">{t('question', { number })}</span>
                <StatusBadge variant="info">{tKind(q.kind)}</StatusBadge>
                {q.mode === 'CHALLENGE' ? <StatusBadge variant="warning">{t('challenge')}</StatusBadge> : null}
                {/* Phase 4.4 (D30): which generator asked, when it was not the frontier (a follow-up, a relationship, a source, continuity). */}
                {q.generator !== 'FRONTIER' ? <StatusBadge variant="neutral" data-testid="generator-badge">{t(`generatorBadge.${q.generator}`)}</StatusBadge> : null}
                {q.reviewRequired ? (
                    <span data-testid="review-required">
                        <StatusBadge variant="warning" tooltip={t('reviewRequiredHint')}>
                            {t('reviewRequired')}
                        </StatusBadge>
                    </span>
                ) : null}
                {q.replacesQuestionId ? <StatusBadge variant="neutral">{t('rephrased')}</StatusBadge> : null}
                {q.origin === 'PACK_FALLBACK' ? <span>{t('packQuestion')}</span> : personaName ? <span>{t('persona', { name: personaName })}</span> : null}
                <span className="ml-auto">{statusBadge}</span>
            </div>
            <p className="text-xs text-content-muted">{about}</p>
            {q.kind === 'SCENARIO' ? (
                <blockquote id={headingId} className="whitespace-pre-wrap border-l-2 border-border-default pl-3 text-base text-content-emphasis">
                    {q.text}
                </blockquote>
            ) : (
                <p id={headingId} className="whitespace-pre-wrap text-base font-medium text-content-emphasis">
                    {q.text}
                </p>
            )}
            {q.challengeQuote ? <p className="border-l-2 border-border-subtle pl-3 text-sm italic text-content-muted">“{q.challengeQuote}”</p> : null}

            {editable ? (
                <AnswerControl
                    question={q}
                    options={options}
                    pick={pick}
                    text={text}
                    onPick={choose}
                    onText={changeText}
                    onBlurText={() => saveNow()}
                    labelledBy={headingId}
                    firstControlRef={firstControlRef}
                    t={t}
                />
            ) : (
                <ReadOnlyAnswer question={q} t={t} />
            )}

            {editable && q.recommendedAnswer !== null ? (
                <div className="flex flex-wrap items-center gap-tight rounded-md border border-border-subtle bg-bg-muted p-3">
                    <span className="text-sm text-content-default" data-testid="recommendation">
                        {t('recommended', { answer: String(q.recommendedAnswer) })}
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => void act('accept')} loading={busy === 'accept'} data-testid="accept-recommended">
                        {t('acceptRecommended')}
                    </Button>
                </div>
            ) : null}

            {editable ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {!isPick(q.kind) || pick !== null ? (
                        <Button variant="primary" size="sm" onClick={saveNow} disabled={!savable} loading={state === 'saving'} data-testid="save-answer">
                            {t('save')}
                        </Button>
                    ) : null}
                    <Button variant="secondary" size="sm" onClick={() => void act('skip')} loading={busy === 'skip'} data-testid="skip">
                        {t('skip')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void act('later')} loading={busy === 'later'} data-testid="decide-later">
                        {t('decideLater')}
                    </Button>
                    {/* Phase 4.4: a question code worded from the author's own material (a quote, a follow-up) is never re-worded. */}
                    {q.answer === null && q.origin !== 'GENERATOR' ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<Repeat2 className="size-3.5" aria-hidden="true" />}
                            onClick={() => void act('rephrase')}
                            loading={busy === 'rephrase'}
                            data-testid="rephrase"
                        >
                            {busy === 'rephrase' ? t('rephrasing') : t('rephrase')}
                        </Button>
                    ) : null}
                    <span className="ml-auto text-xs" role="status" aria-live="polite" data-testid="save-state" data-state={state}>
                        {state === 'saving' ? t('saving') : state === 'error' && error ? <span className="text-content-error">{t('saveFailed', { reason: error })}</span> : state === 'saved' && !unsaved ? t('saved') : null}
                    </span>
                    {state === 'error' && failed ? (
                        <Button variant="secondary" size="sm" onClick={() => void send(failed)} data-testid="retry-answer">
                            {t('retry')}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {editable && error && state !== 'error' ? (
                <p className="text-sm text-content-error" role="alert">
                    {error}
                </p>
            ) : null}
            {editable ? (
                <p className="flex items-center gap-1 text-xs text-content-muted">
                    <CornerDownRight className="size-3" aria-hidden="true" />
                    {isPick(q.kind) ? t('keys', { count: options.length }) : t('keysText')}
                </p>
            ) : null}
        </Card>
    );
});

function AnswerControl({
    question: q,
    options,
    pick,
    text,
    onPick,
    onText,
    onBlurText,
    labelledBy,
    firstControlRef,
    t,
}: {
    question: QuestionView;
    options: string[];
    pick: string | number | null;
    text: string;
    onPick: (v: string | number) => void;
    onText: (v: string) => void;
    onBlurText: () => void;
    labelledBy: string;
    firstControlRef: React.MutableRefObject<HTMLElement | null>;
    t: ReturnType<typeof useTranslations>;
}) {
    const textId = `answer-${q.id}-text`;
    const textBox = (label: string, rows: number) => (
        <div className="space-y-tight">
            <label htmlFor={textId} className="text-sm font-medium text-content-emphasis">
                {label}
            </label>
            <Textarea
                id={textId}
                ref={!isPick(q.kind) ? (el: HTMLTextAreaElement | null) => void (firstControlRef.current = el) : undefined}
                value={text}
                rows={rows}
                onChange={(e) => onText(e.target.value)}
                onBlur={onBlurText}
                data-testid="answer-text"
            />
        </div>
    );
    if (!isPick(q.kind)) return textBox(t('yourAnswer'), q.kind === 'SCENARIO' ? 5 : 3);

    const items: ReactNode[] = options.map((o, i) => {
        const value = q.kind === 'SCALE' ? i + 1 : o;
        const id = `answer-${q.id}-opt-${i}`;
        return (
            <div key={id} className={q.kind === 'SCALE' ? 'flex flex-col items-center gap-1' : 'flex items-center gap-tight'}>
                <RadioGroupItem
                    id={id}
                    value={String(value)}
                    ref={i === 0 ? (el: HTMLButtonElement | null) => void (firstControlRef.current = el) : undefined}
                    data-testid="answer-option"
                />
                <label htmlFor={id} className="text-sm text-content-default">
                    {q.kind === 'SCALE' ? o : `${i + 1}. ${o}`}
                </label>
            </div>
        );
    });
    return (
        <div className="space-y-default">
            <RadioGroup
                aria-labelledby={labelledBy}
                value={pick === null ? '' : String(pick)}
                onValueChange={(v) => onPick(q.kind === 'SCALE' ? Number(v) : v)}
                className={q.kind === 'SCALE' ? 'flex flex-wrap items-end gap-default' : undefined}
                data-testid="answer-options"
            >
                {q.kind === 'SCALE' && q.scaleLabels ? <span className="text-xs text-content-muted">{t('scaleLow', { label: q.scaleLabels.low })}</span> : null}
                {items}
                {q.kind === 'SCALE' && q.scaleLabels ? <span className="text-xs text-content-muted">{t('scaleHigh', { label: q.scaleLabels.high })}</span> : null}
            </RadioGroup>
            {pick !== null ? textBox(t('reason'), 2) : null}
        </div>
    );
}

function ReadOnlyAnswer({ question: q, t }: { question: QuestionView; t: ReturnType<typeof useTranslations> }) {
    const a = q.answer;
    return (
        <div className="space-y-tight text-sm">
            {q.options ? (
                <ul className="list-inside list-decimal text-content-default">
                    {q.options.map((o) => (
                        <li key={o}>{o}</li>
                    ))}
                </ul>
            ) : null}
            {q.kind === 'SCALE' && q.scaleLabels ? (
                <p className="text-content-muted">
                    {t('scaleLow', { label: q.scaleLabels.low })} · {t('scaleHigh', { label: q.scaleLabels.high })}
                </p>
            ) : null}
            {a?.status === 'ANSWERED' ? (
                <div data-testid="answer-readonly">
                    <p className="font-medium text-content-emphasis">{t('yourAnswer')}</p>
                    <p className="whitespace-pre-wrap text-content-default">{[a.choice, a.scale === null ? null : String(a.scale), a.text].filter((x) => x !== null && x !== '').join(' — ')}</p>
                </div>
            ) : null}
        </div>
    );
}
