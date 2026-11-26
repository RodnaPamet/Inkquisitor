'use client';

/**
 * The interview's setup (Phase 2.4): a `<Sheet>` that opens from "Enrich" on
 * an element or "Grill me" on a kind or the book, shows the dials with a
 * one-line preview of what each setting does, and starts the interview on its
 * own page (`APP_ROUTES.newInterview`, the setup in the query), where the
 * first round streams in.
 *
 * What it may offer comes from `src/lib/interview/setup.ts`, the one seam to
 * the dials API (Phase 2.3): the personas with their mount status (one that
 * does not mount is shown disabled, with its reason), up to three chosen in
 * order, and the book's effective defaults with where each came from. The
 * previews are the server's `effects` for those defaults, and the same pure
 * rule (`dialEffects`) once the author moves a dial (`previewEffects`).
 *
 * Phase 4.3 (D29): the PANEL preset (`panelSetup`) questions the book with the
 * book-level panel — Target Reader, Ruthless Editor and Genre Specialist — in
 * place of the persona picker; its questions are grouped by who asked.
 *
 * Phase 4.4 (D23, D30): the SESSION LENGTH — a number of rounds, a number of
 * questions, or until the author stops (each a choice of a few numbers, never a
 * free number field) — and the QUESTION GENERATORS, each a checkbox, all on by
 * default; the last one on cannot be switched off (`withGenerator`).
 */
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Sheet } from '@/components/ui/sheet';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { APP_ROUTES } from '@/lib/app-routes';
import {
    interviewSetupQuery,
    isPanelSetup,
    loadSetupOptions,
    panelSetup,
    previewEffects,
    sessionLengthFrom,
    withGenerator,
    type InterviewSetup,
    type InterviewTarget,
    type SetupOptions,
    type SetupSource,
} from '@/lib/interview/setup';
import { QUESTION_GENERATORS, type PersonaKey } from '@/lib/interview/vocabulary';
import type { SessionLength } from '@/lib/interview/session-length';

export interface InterviewSetupSheetProps {
    open: boolean;
    setOpen: (open: boolean) => void;
    workspaceSlug: string;
    bookId: string;
    target: InterviewTarget;
    /** The sheet's title, worded by the opener (an element's name, a kind's label, the book). */
    title: string;
}

const DIAL_OPTIONS = ['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }));
/** Phase 4.4 (D23): the numbers a ROUNDS or QUESTIONS session may be given here (the API takes any within its bounds). */
const ROUND_COUNTS = ['2', '4', '6', '10', '20'].map((v) => ({ value: v, label: v }));
const QUESTION_COUNTS = ['10', '20', '40', '80', '150'].map((v) => ({ value: v, label: v }));
const LENGTH_MODES: readonly SessionLength['mode'][] = ['ROUNDS', 'QUESTIONS', 'UNTIL_STOPPED'];

export function InterviewSetupSheet({ open, setOpen, workspaceSlug, bookId, target, title }: InterviewSetupSheetProps) {
    const t = useTranslations('interview.setup');
    const tPersona = useTranslations('interview.personas');
    const router = useRouter();
    const ids = useId();
    const [options, setOptions] = useState<SetupOptions | null>(null);
    const [failed, setFailed] = useState(false);
    const [setup, setSetup] = useState<InterviewSetup | null>(null);

    useEffect(() => {
        if (!open || options) return;
        let live = true;
        loadSetupOptions(workspaceSlug, bookId)
            .then((o) => {
                if (!live) return;
                setOptions(o);
                setSetup((s) => s ?? { ...o.defaults, personaKeys: [...o.defaults.personaKeys] });
            })
            .catch(() => live && setFailed(true));
        return () => {
            live = false;
        };
    }, [open, options, workspaceSlug, bookId]);

    const change = <K extends keyof InterviewSetup>(key: K, value: InterviewSetup[K]) => setSetup((s) => (s ? { ...s, [key]: value } : s));

    function start() {
        if (!setup) return;
        setOpen(false);
        router.push(APP_ROUTES.newInterview(workspaceSlug, bookId, interviewSetupQuery(target, setup)));
    }

    function togglePersona(key: PersonaKey, on: boolean) {
        if (!setup || !options) return;
        // At the limit the unchosen boxes are disabled, so a pick never silently drops an earlier one.
        if (on && (setup.personaKeys.includes(key) || setup.personaKeys.length >= options.maxPersonas)) return;
        change('personaKeys', on ? [...setup.personaKeys, key] : setup.personaKeys.filter((k) => k !== key));
    }

    const effects = options && setup ? previewEffects(options, setup) : null;
    /** "Default from this book / the workspace", while the dial still holds that default. */
    const sourceNote = (key: Exclude<keyof InterviewSetup, 'length'>): string | null => {
        if (!options || !setup) return null;
        const source: SetupSource = options.sources[key];
        if (source === 'code') return null;
        const same =
            key === 'personaKeys' || key === 'generatorsOff' ? setup[key].join(',') === options.defaults[key].join(',') : setup[key] === options.defaults[key];
        return same ? t(source === 'book' ? 'sourceBook' : 'sourceWorkspace') : null;
    };
    const refusalText = (code: string | null) => t.has(`packRefusal.${code}`) ? t(`packRefusal.${code}`) : t('packRefusal.generic');
    const panelOn = setup ? isPanelSetup(setup) : false;
    const setPanel = (on: boolean) => {
        if (!setup || !options) return;
        setSetup(on ? panelSetup(setup) : { ...setup, personaKeys: [...options.defaults.personaKeys] });
    };

    return (
        // `autoFocus`: focus goes into the sheet on open (vaul's default leaves it on the opener).
        <Sheet open={open} onOpenChange={setOpen} size="md" title={title} description={t('description')} autoFocus>
            <Sheet.Header title={title} description={t('description')} />
            <Sheet.Body className="space-y-section" data-testid="interview-setup">
                {!setup || !options || !effects ? (
                    <p className="text-sm text-content-muted" role="status">
                        {failed ? t('loadFailed') : t('loading')}
                    </p>
                ) : (
                    <>
                        <div role="group" aria-labelledby={`${ids}-depth`} aria-describedby={`${ids}-depth-preview`} className="space-y-tight">
                            <p id={`${ids}-depth`} className="text-sm font-medium text-content-emphasis">
                                {t('depth')}
                            </p>
                            <p className="text-xs text-content-muted">{t('depthHelp')}</p>
                            <ToggleGroup ariaLabel={t('depth')} options={DIAL_OPTIONS} selected={String(setup.depth)} selectAction={(v) => change('depth', Number(v))} />
                            <p id={`${ids}-depth-preview`} className="text-sm text-content-default" data-testid="depth-preview" aria-live="polite">
                                {t(`depthPreview.${setup.depth}`, { layers: effects.ladderLayers })}
                            </p>
                            <SourceNote text={sourceNote('depth')} />
                        </div>
                        <div role="group" aria-labelledby={`${ids}-detail`} aria-describedby={`${ids}-detail-preview`} className="space-y-tight">
                            <p id={`${ids}-detail`} className="text-sm font-medium text-content-emphasis">
                                {t('detail')}
                            </p>
                            <p className="text-xs text-content-muted">{t('detailHelp')}</p>
                            <ToggleGroup ariaLabel={t('detail')} options={DIAL_OPTIONS} selected={String(setup.detail)} selectAction={(v) => change('detail', Number(v))} />
                            <p id={`${ids}-detail-preview`} className="text-sm text-content-default" data-testid="detail-preview" aria-live="polite">
                                {t(`detailPreview.${setup.detail}`, { cap: effects.roundCap })}
                            </p>
                            <SourceNote text={sourceNote('detail')} />
                        </div>
                        <div role="group" aria-labelledby={`${ids}-length`} aria-describedby={`${ids}-length-preview`} className="space-y-tight" data-testid="session-length">
                            <p id={`${ids}-length`} className="text-sm font-medium text-content-emphasis">
                                {t('length.title')}
                            </p>
                            <p className="text-xs text-content-muted">{t('length.help')}</p>
                            <RadioGroup
                                aria-labelledby={`${ids}-length`}
                                value={setup.length.mode}
                                onValueChange={(v) => change('length', sessionLengthFrom(v as SessionLength['mode'], v === 'QUESTIONS' ? 20 : 4))}
                            >
                                {LENGTH_MODES.map((mode) => (
                                    <div key={mode} className="flex items-center gap-tight">
                                        <RadioGroupItem id={`${ids}-len-${mode}`} value={mode} />
                                        <label htmlFor={`${ids}-len-${mode}`} className="text-sm text-content-emphasis">
                                            {t(`length.mode.${mode}`)}
                                        </label>
                                    </div>
                                ))}
                            </RadioGroup>
                            {setup.length.mode === 'ROUNDS' ? (
                                <ToggleGroup ariaLabel={t('length.rounds')} options={ROUND_COUNTS} selected={String(setup.length.rounds)} selectAction={(v) => change('length', sessionLengthFrom('ROUNDS', Number(v)))} />
                            ) : setup.length.mode === 'QUESTIONS' ? (
                                <ToggleGroup ariaLabel={t('length.questions')} options={QUESTION_COUNTS} selected={String(setup.length.questions)} selectAction={(v) => change('length', sessionLengthFrom('QUESTIONS', Number(v)))} />
                            ) : null}
                            <p id={`${ids}-length-preview`} className="text-sm text-content-default" data-testid="length-preview" aria-live="polite">
                                {setup.length.mode === 'ROUNDS'
                                    ? t('length.preview.ROUNDS', { rounds: setup.length.rounds })
                                    : setup.length.mode === 'QUESTIONS'
                                      ? t('length.preview.QUESTIONS', { questions: setup.length.questions })
                                      : t('length.preview.UNTIL_STOPPED')}
                            </p>
                        </div>
                        <div role="group" aria-labelledby={`${ids}-generators`} className="space-y-tight" data-testid="generator-toggles">
                            <p id={`${ids}-generators`} className="text-sm font-medium text-content-emphasis">
                                {t('generators.title')}
                            </p>
                            <p className="text-xs text-content-muted">{t('generators.help')}</p>
                            <ul className="space-y-tight">
                                {QUESTION_GENERATORS.map((g) => {
                                    const on = !setup.generatorsOff.includes(g);
                                    const last = on && setup.generatorsOff.length === QUESTION_GENERATORS.length - 1;
                                    return (
                                        <li key={g} className="flex items-start gap-tight">
                                            <Checkbox
                                                id={`${ids}-gen-${g}`}
                                                checked={on}
                                                disabled={last}
                                                onCheckedChange={(v) => setSetup((s) => (s ? withGenerator(s, g, v === true) : s))}
                                                aria-describedby={`${ids}-gen-${g}-summary`}
                                                className="mt-0.5"
                                            />
                                            <label htmlFor={`${ids}-gen-${g}`} className="text-sm">
                                                <span className="font-medium text-content-emphasis">{t(`generators.${g}.name`)}</span>
                                                <span id={`${ids}-gen-${g}-summary`} className="block text-xs text-content-muted">
                                                    {t(`generators.${g}.summary`)}
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>
                            <SourceNote text={sourceNote('generatorsOff')} />
                        </div>
                        <div role="group" aria-labelledby={`${ids}-panel`} className="space-y-tight" data-testid="panel-preset">
                            <p id={`${ids}-panel`} className="text-sm font-medium text-content-emphasis">
                                {t('panel.title')}
                            </p>
                            <div className="flex items-start gap-tight">
                                <Checkbox
                                    id={`${ids}-panel-on`}
                                    checked={panelOn}
                                    disabled={!options.panel.mountable}
                                    onCheckedChange={(v) => setPanel(v === true)}
                                    aria-describedby={`${ids}-panel-help`}
                                    className="mt-0.5"
                                />
                                {/* The help is a description, outside the label, so the checkbox is named "Panel" alone (its help names the personas). */}
                                <div className="text-sm">
                                    <label htmlFor={`${ids}-panel-on`} className="font-medium text-content-emphasis">
                                        {t('panel.label')}
                                    </label>
                                    <p id={`${ids}-panel-help`} className="text-xs text-content-muted">
                                        {options.panel.mountable ? t('panel.help') : refusalText(options.panel.refusal)}
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div role="group" aria-labelledby={`${ids}-persona`} className="space-y-tight" hidden={panelOn}>
                            <p id={`${ids}-persona`} className="text-sm font-medium text-content-emphasis">
                                {t('persona')}
                            </p>
                            <p className="text-xs text-content-muted">{options.maxPersonas > 1 ? t('personaLimit', { max: options.maxPersonas }) : t('personaHelp')}</p>
                            {options.maxPersonas === 1 ? (
                                <RadioGroup
                                    aria-labelledby={`${ids}-persona`}
                                    value={setup.personaKeys[0] ?? 'none'}
                                    onValueChange={(v) => change('personaKeys', v === 'none' ? [] : [v as PersonaKey])}
                                    data-testid="persona-picker"
                                >
                                    <PersonaRow id={`${ids}-p-none`} value="none" name={t('personaNone')} summary={t('personaNoneSummary')} />
                                    {options.personas.map((p) => (
                                        <PersonaRow
                                            key={p.key}
                                            id={`${ids}-p-${p.key}`}
                                            value={p.key}
                                            name={tPersona(`${p.key}.name`)}
                                            summary={p.mountable ? tPersona(`${p.key}.summary`) : refusalText(p.refusal)}
                                            disabled={!p.mountable}
                                        />
                                    ))}
                                </RadioGroup>
                            ) : (
                                <ul className="space-y-tight" data-testid="persona-picker">
                                    {options.personas.map((p) => {
                                        const chosen = setup.personaKeys.indexOf(p.key);
                                        return (
                                            <li key={p.key} className="flex items-start gap-tight">
                                                <Checkbox
                                                    id={`${ids}-pc-${p.key}`}
                                                    checked={chosen >= 0}
                                                    disabled={!p.mountable || (chosen < 0 && setup.personaKeys.length >= options.maxPersonas)}
                                                    onCheckedChange={(v) => togglePersona(p.key, v === true)}
                                                    aria-describedby={`${ids}-pc-${p.key}-summary`}
                                                    className="mt-0.5"
                                                />
                                                <label htmlFor={`${ids}-pc-${p.key}`} className="text-sm">
                                                    <span className="font-medium text-content-emphasis">
                                                        {tPersona(`${p.key}.name`)}
                                                        {chosen >= 0 && setup.personaKeys.length > 1 ? <span className="ml-1 text-xs text-content-muted">{t('personaOrder', { n: chosen + 1 })}</span> : null}
                                                    </span>
                                                    <span id={`${ids}-pc-${p.key}-summary`} className="block text-xs text-content-muted">
                                                        {p.mountable ? tPersona(`${p.key}.summary`) : refusalText(p.refusal)}
                                                    </span>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            <p className="text-sm text-content-default" data-testid="persona-preview" aria-live="polite">
                                {setup.personaKeys.length === 0
                                    ? t('personaPreview.none')
                                    : setup.personaKeys.length === 1
                                      ? t('personaPreview.one')
                                      : t('personaPreview.many', { count: setup.personaKeys.length, calls: effects.generationCallsPerRound })}
                            </p>
                            <SourceNote text={sourceNote('personaKeys')} />
                        </div>
                        <div role="group" aria-labelledby={`${ids}-toggles`} className="space-y-default">
                            <p id={`${ids}-toggles`} className="text-sm font-medium text-content-emphasis">
                                {t('toggles')}
                            </p>
                            <ToggleRow
                                id={`${ids}-recommend`}
                                label={t('offerRecommended')}
                                preview={setup.offerRecommended ? t('offerRecommendedOn') : t('offerRecommendedOff')}
                                checked={setup.offerRecommended}
                                onChange={(v) => change('offerRecommended', v)}
                            />
                            <ToggleRow
                                id={`${ids}-choice`}
                                label={t('preferChoice')}
                                preview={setup.preferChoice ? t('preferChoiceOn') : t('preferChoiceOff')}
                                checked={setup.preferChoice}
                                onChange={(v) => change('preferChoice', v)}
                            />
                        </div>
                    </>
                )}
            </Sheet.Body>
            <Sheet.Actions>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                    {t('cancel')}
                </Button>
                <Button variant="primary" onClick={start} disabled={!setup} id="interview-start">
                    {t('start')}
                </Button>
            </Sheet.Actions>
        </Sheet>
    );
}

function SourceNote({ text }: { text: string | null }) {
    return text ? <p className="text-xs text-content-muted">{text}</p> : null;
}

function PersonaRow({ id, value, name, summary, disabled }: { id: string; value: string; name: string; summary: string; disabled?: boolean }) {
    return (
        <div className="flex items-start gap-tight">
            <RadioGroupItem id={id} value={value} disabled={disabled} aria-describedby={`${id}-summary`} className="mt-0.5" />
            <label htmlFor={id} className="text-sm">
                <span className="font-medium text-content-emphasis">{name}</span>
                <span id={`${id}-summary`} className="block text-xs text-content-muted">
                    {summary}
                </span>
            </label>
        </div>
    );
}

function ToggleRow({ id, label, preview, checked, onChange }: { id: string; label: string; preview: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-start gap-tight">
            <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} aria-describedby={`${id}-preview`} className="mt-0.5" />
            <label htmlFor={id} className="text-sm">
                <span className="font-medium text-content-emphasis">{label}</span>
                <span id={`${id}-preview`} className="block text-xs text-content-muted">
                    {preview}
                </span>
            </label>
        </div>
    );
}
