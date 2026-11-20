'use client';

/**
 * A book's Research page (Phase 2.6, decision D9).
 *
 *   a brief      the author writes the question, what it is for, the bible
 *                elements it is about (a `<Combobox multiple>`), any URLs, and
 *                a depth; files are attached to it afterwards
 *   a run        dispatched from the brief; its progress (searching, reading
 *                N sources, drafting findings, fitting) streams in over the
 *                lifted SSE contract while the background job works
 *   findings     each claim with its quoted sources, linked; one can be kept as
 *                a research note
 *   proposals    reviewed with 2.5's review UI: a `<VersionDiff>` of the field
 *                now against the proposed value, Accept, Edit then accept (the
 *                bible's own `<FieldEditor>`), Reject; a new element shown apart
 *
 * Zero is never complete (rule 6): a run that kept no finding says why, in
 * words, from its outcome. What the viewer may do is `canEdit` (`bible.edit`),
 * decided on the server; a reader reads. A refusal is worded from its
 * `details.reason` (`research.errors`). Every text renders as text: quotes and
 * values are never HTML (a rich-text value goes through the diff's own strip).
 */
import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, FileUp, Pencil, Play, Search, X } from 'lucide-react';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { FieldEditor } from '@/components/bible/FieldEditor';
import { valueAsDiffHtml } from '@/components/enrichment/SessionReview';
import { APP_ROUTES } from '@/lib/app-routes';
import { BibleApiError } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import type { BibleKind } from '@/lib/bible/kinds';
import {
    RESEARCH_API,
    researchApi,
    type BriefView,
    type FindingView,
    type ResearchFieldProposalView,
    type ResearchIds,
    type ResearchNewElementView,
    type RunReviewView,
    type RunView,
} from '@/lib/research/api-client';
import { RESEARCH_DEPTHS, type ResearchDepth } from '@/lib/research/vocabulary';
import { useResearchStream } from './use-research-stream';

export interface ResearchPageProps {
    workspaceSlug: string;
    book: { id: string; title: string };
    briefs: BriefView[];
    truncated: boolean;
    /** The book's elements a brief may be scoped to (names and kinds). */
    elements: Array<{ id: string; name: string; kind: BibleKind }>;
    kindLabels: Record<BibleKind, string>;
    canEdit: boolean;
    /** A review shown open at first (the latest finished run of the newest brief). */
    initialReview?: RunReviewView | null;
}

const live = (r: RunView | null) => r !== null && (r.status === 'QUEUED' || r.status === 'RUNNING');

function useErrorText() {
    const t = useTranslations('research.errors');
    return useCallback(
        (err: unknown) => {
            const reason = err instanceof BibleApiError ? err.reason : null;
            return reason && t.has(reason) ? t(reason) : t('generic');
        },
        [t],
    );
}

function statusVariant(status: string): 'info' | 'success' | 'neutral' | 'warning' {
    if (status === 'QUEUED' || status === 'RUNNING' || status === 'PENDING') return 'info';
    if (status === 'DONE' || status === 'ACCEPTED' || status === 'EDITED_ACCEPTED') return 'success';
    if (status === 'FAILED' || status === 'REFUSED') return 'warning';
    return 'neutral';
}

// ─── The brief form ────────────────────────────────────────────────

function NewBriefForm({ ids, elements, kindLabels, onCreated }: { ids: ResearchIds; elements: ResearchPageProps['elements']; kindLabels: ResearchPageProps['kindLabels']; onCreated: () => Promise<void> }) {
    const t = useTranslations('research.newBrief');
    const errorText = useErrorText();
    const [question, setQuestion] = useState('');
    const [purpose, setPurpose] = useState('');
    const [scope, setScope] = useState<ComboboxOption[]>([]);
    const [urls, setUrls] = useState('');
    const [depth, setDepth] = useState<ResearchDepth>('QUICK');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const options: ComboboxOption[] = useMemo(() => elements.map((e) => ({ value: e.id, label: `${e.name} (${kindLabels[e.kind] ?? e.kind})` })), [elements, kindLabels]);
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (!question.trim() || !purpose.trim()) {
            setError(t('required'));
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await researchApi.createBrief(ids, {
                question,
                purpose,
                depth,
                scopeElementIds: scope.map((o) => o.value),
                urls: urls.split(/\s+/).map((u) => u.trim()).filter((u) => u !== ''),
            });
            setQuestion('');
            setPurpose('');
            setScope([]);
            setUrls('');
            toast.success(t('created'));
            await onCreated();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Card className="space-y-default p-5">
            <form onSubmit={submit} className="space-y-default" aria-labelledby="new-brief-title" id="new-brief-form">
                <h2 id="new-brief-title" className="text-base font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                <p className="text-sm text-content-muted">{t('privacy')}</p>
                <FormField label={t('question')} description={t('questionHelp')} required>
                    <Textarea id="brief-question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} />
                </FormField>
                <FormField label={t('purpose')} description={t('purposeHelp')} required>
                    <Textarea id="brief-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} />
                </FormField>
                <FormField label={t('scope')} description={t('scopeHelp')}>
                    <Combobox
                        multiple
                        options={options}
                        selected={scope}
                        setSelected={setScope}
                        placeholder={t('scopePlaceholder')}
                        searchPlaceholder={t('scopeSearch')}
                        matchTriggerWidth
                        id="brief-scope"
                    />
                </FormField>
                <FormField label={t('urls')} description={t('urlsHelp')}>
                    <Textarea id="brief-urls" value={urls} onChange={(e) => setUrls(e.target.value)} rows={2} />
                </FormField>
                <fieldset className="space-y-tight">
                    <legend className="text-sm font-medium text-content-emphasis">{t('depth')}</legend>
                    <RadioGroup value={depth} onValueChange={(v) => setDepth(v as ResearchDepth)} aria-label={t('depth')} className="space-y-tight">
                        {RESEARCH_DEPTHS.map((d) => (
                            <div key={d} className="flex items-start gap-tight">
                                <RadioGroupItem value={d} id={`brief-depth-${d}`} />
                                <label htmlFor={`brief-depth-${d}`} className="text-sm text-content-default">
                                    <span className="font-medium">{t(`depths.${d}`)}</span> — {t(`depthHelp.${d}`)}
                                </label>
                            </div>
                        ))}
                    </RadioGroup>
                </fieldset>
                {error ? (
                    <p className="text-sm text-content-error" role="alert">
                        {error}
                    </p>
                ) : null}
                <Button type="submit" variant="primary" icon={<Search className="size-4" aria-hidden="true" />} loading={busy} id="brief-submit">
                    {t('submit')}
                </Button>
            </form>
        </Card>
    );
}

// ─── A run: progress, outcome, review ──────────────────────────────

function RunSummary({ run, progress }: { run: RunView; progress: RunView['progress'] }) {
    const t = useTranslations('research');
    return (
        <div className="space-y-tight" data-testid="run-summary" data-status={run.status} data-outcome={run.outcome ?? ''}>
            {live(run) ? (
                <p className="text-sm text-content-default" role="status" aria-live="polite" data-testid="run-progress">
                    {t(`phase.${progress.phase}`)} · {t('counts', { searches: progress.searches, fetches: progress.fetches, sources: progress.sources, findings: progress.findings, proposals: progress.proposals })}
                </p>
            ) : (
                <>
                    <p className="text-sm text-content-default" data-testid="run-outcome">
                        {run.outcome ? t(`outcome.${run.outcome}`) : t(`status.${run.status}`)}
                    </p>
                    <p className="text-xs text-content-muted">
                        {t('counts', { searches: run.metrics.searches, fetches: run.metrics.fetches, sources: run.metrics.sourcesRead, findings: run.metrics.findingsKept, proposals: run.metrics.proposalsKept })}
                    </p>
                    {run.metrics.reviewRequired ? <p className="text-sm text-content-warning">{t('guardFlag')}</p> : null}
                </>
            )}
        </div>
    );
}

function FindingCard({ f, canEdit, busy, onKeep, workspaceSlug, bookId }: { f: FindingView; canEdit: boolean; busy: boolean; onKeep: (f: FindingView) => Promise<void>; workspaceSlug: string; bookId: string }) {
    const t = useTranslations('research.findings');
    const headingId = `finding-${f.id}-title`;
    return (
        <Card className="space-y-default p-5" data-testid="research-finding" aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <h4 id={headingId} className="min-w-0 text-base font-semibold text-content-emphasis">
                    <span className="mr-2 text-content-muted">{f.ref}</span>
                    {f.claim}
                </h4>
                <StatusBadge variant="neutral">{t(`confidence.${f.confidence}`)}</StatusBadge>
            </div>
            <p className="whitespace-pre-wrap text-sm text-content-default">{f.summary}</p>
            <ul className="space-y-tight" aria-label={t('sources')}>
                {f.citations.map((c) => (
                    <li key={c.id} className="rounded-md border border-border-subtle bg-bg-muted p-2 text-sm" data-testid="finding-citation">
                        <blockquote className="whitespace-pre-wrap text-content-default">“{c.quotedSpan}”</blockquote>
                        <p className="mt-1 text-xs text-content-muted">
                            {c.kind === 'URL' && c.url ? (
                                <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="text-content-emphasis underline">
                                    {c.title || c.url}
                                </a>
                            ) : (
                                <span>{t('attachedFile', { name: c.title ?? '' })}</span>
                            )}
                        </p>
                    </li>
                ))}
            </ul>
            {f.noFitReason ? <p className="text-sm text-content-muted">{t('noFit', { reason: f.noFitReason })}</p> : null}
            {f.keptElementId ? (
                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, f.keptElementId)} className="text-sm text-content-emphasis hover:underline">
                    {t('openNote')}
                </Link>
            ) : canEdit ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onKeep(f)} id={`keep-${f.id}`}>
                    {t('keep')}
                </Button>
            ) : null}
        </Card>
    );
}

function Sources({ ids, findings }: { ids: readonly string[]; findings: readonly FindingView[] }) {
    const t = useTranslations('research.proposals');
    const byId = new Map(findings.map((f) => [f.id, f] as const));
    return (
        <div className="space-y-tight">
            <p className="text-xs font-medium uppercase tracking-wide text-content-muted">{t('cites')}</p>
            <ul className="space-y-tight" data-testid="proposal-sources">
                {ids.map((id) => {
                    const f = byId.get(id);
                    return (
                        <li key={id} className="rounded-md border border-border-subtle bg-bg-muted p-2 text-sm text-content-default">
                            {f ? `${f.ref} — ${f.claim}` : t('findingMissing')}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function Flags({ flags }: { flags: readonly string[] }) {
    const t = useTranslations('research.proposals');
    if (!flags.includes('POSSIBLE_INSTRUCTION')) return null;
    return (
        <p className="rounded-md border border-border-default bg-bg-subtle p-3 text-sm text-content-default" data-testid="proposal-flag">
            {t('possibleInstruction')}
        </p>
    );
}

function FieldProposalCard({
    p,
    findings,
    canEdit,
    busy,
    onAccept,
    onReject,
    scaleOf,
    workspaceSlug,
    bookId,
}: {
    p: ResearchFieldProposalView;
    findings: readonly FindingView[];
    canEdit: boolean;
    busy: boolean;
    onAccept: (p: ResearchFieldProposalView, value?: FieldValue | null) => Promise<boolean>;
    onReject: (id: string) => Promise<void>;
    scaleOf: (n: number) => string;
    workspaceSlug: string;
    bookId: string;
}) {
    const t = useTranslations('enrichment');
    const tr = useTranslations('research.proposals');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<FieldValue | null>(p.proposedValue);
    const pending = p.status === 'PENDING';
    const changed = p.baseVersion !== p.currentVersion;
    const headingId = `research-proposal-${p.id}-title`;
    const versions = [
        { id: 'current', versionNumber: Math.max(p.currentVersion, 1), contentType: 'HTML', text: valueAsDiffHtml(p.field, p.currentValue, scaleOf) },
        { id: 'proposed', versionNumber: Math.max(p.currentVersion, 1) + 1, contentType: 'HTML', text: valueAsDiffHtml(p.field, p.proposedValue, scaleOf) },
    ];
    return (
        <Card className="space-y-default p-5" data-testid="research-field-proposal" data-status={p.status} data-op={p.operation} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h4 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {p.field.label}
                    </h4>
                    <p className="text-sm text-content-muted">
                        <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, p.elementId)} className="hover:underline">
                            {p.elementName}
                        </Link>
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-tight">
                    <StatusBadge variant="info">{t(`op.${p.operation}`)}</StatusBadge>
                    <StatusBadge variant={statusVariant(p.status)} data-testid="proposal-status">
                        {t(`status.${p.status}`)}
                    </StatusBadge>
                </div>
            </div>
            <Flags flags={p.flags} />
            {pending && changed ? <p className="rounded-md border border-border-default bg-bg-subtle p-3 text-sm text-content-default">{t('changedSince', { base: p.baseVersion, current: p.currentVersion })}</p> : null}
            {pending ? <VersionDiff versions={versions} fromVersionId="current" toVersionId="proposed" data-testid={`research-diff-${p.id}`} /> : null}
            <p className="text-sm text-content-default">
                <span className="font-medium">{tr('rationale')}</span> {p.rationale}
            </p>
            {editing ? (
                <div className="space-y-default rounded-md border border-border-subtle p-3">
                    <p className="text-sm font-medium text-content-emphasis">{t('editing')}</p>
                    <FieldEditor def={p.field} value={draft} onChange={setDraft} readOnly={false} />
                </div>
            ) : null}
            <Sources ids={p.findingIds} findings={findings} />
            {canEdit && pending ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {editing ? (
                        <>
                            <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={async () => { if (await onAccept(p, draft)) setEditing(false); }} id={`research-accept-edit-${p.id}`}>
                                {t('saveAccept')}
                            </Button>
                            <Button variant="secondary" onClick={() => setEditing(false)} id={`research-cancel-edit-${p.id}`}>
                                {t('cancelEdit')}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={() => void onAccept(p)} aria-label={t('acceptAria', { field: p.field.label, element: p.elementName })} id={`research-accept-${p.id}`}>
                                {t('accept')}
                            </Button>
                            <Button variant="secondary" icon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => { setDraft(p.proposedValue); setEditing(true); }} id={`research-edit-${p.id}`}>
                                {t('edit')}
                            </Button>
                            <Button variant="secondary" icon={<X className="size-4" aria-hidden="true" />} disabled={busy} onClick={() => void onReject(p.id)} aria-label={t('rejectAria', { field: p.field.label, element: p.elementName })} id={`research-reject-${p.id}`}>
                                {t('reject')}
                            </Button>
                        </>
                    )}
                </div>
            ) : null}
        </Card>
    );
}

function NewElementCard({ p, findings, canEdit, busy, kindLabel, onAccept, onReject }: { p: ResearchNewElementView; findings: readonly FindingView[]; canEdit: boolean; busy: boolean; kindLabel: string; onAccept: (p: ResearchNewElementView, edit?: { name: string; summary: string | null }) => Promise<boolean>; onReject: (id: string) => Promise<void> }) {
    const t = useTranslations('enrichment');
    const tr = useTranslations('research.proposals');
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(p.name);
    const [summary, setSummary] = useState(p.summary ?? '');
    const pending = p.status === 'PENDING';
    const headingId = `research-proposal-${p.id}-title`;
    return (
        <Card className="space-y-default p-5" data-testid="research-new-element" data-status={p.status} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h4 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {p.name}
                    </h4>
                    <p className="text-sm text-content-muted">{t('kindLabel', { kind: kindLabel })}</p>
                </div>
                <StatusBadge variant={statusVariant(p.status)} data-testid="proposal-status">
                    {t(`status.${p.status}`)}
                </StatusBadge>
            </div>
            <Flags flags={p.flags} />
            {p.summary && !editing ? <p className="whitespace-pre-wrap text-sm text-content-default">{p.summary}</p> : null}
            <p className="text-sm text-content-default">
                <span className="font-medium">{tr('rationale')}</span> {p.rationale}
            </p>
            {editing ? (
                <div className="space-y-default rounded-md border border-border-subtle p-3">
                    <FormField label={t('nameLabel')} required>
                        <Input value={name} onChange={(e) => setName(e.target.value)} id={`research-new-name-${p.id}`} />
                    </FormField>
                    <FormField label={t('summaryLabel')}>
                        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} id={`research-new-summary-${p.id}`} />
                    </FormField>
                </div>
            ) : null}
            <Sources ids={p.findingIds} findings={findings} />
            {canEdit && pending ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {editing ? (
                        <>
                            <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} disabled={name.trim() === ''} onClick={async () => { if (await onAccept(p, { name, summary: summary.trim() === '' ? null : summary })) setEditing(false); }} id={`research-accept-edit-${p.id}`}>
                                {t('saveAccept')}
                            </Button>
                            <Button variant="secondary" onClick={() => setEditing(false)} id={`research-cancel-edit-${p.id}`}>
                                {t('cancelEdit')}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="primary" icon={<Check className="size-4" aria-hidden="true" />} loading={busy} onClick={() => void onAccept(p)} id={`research-accept-${p.id}`}>
                                {t('accept')}
                            </Button>
                            <Button variant="secondary" icon={<Pencil className="size-4" aria-hidden="true" />} onClick={() => setEditing(true)} id={`research-edit-${p.id}`}>
                                {t('edit')}
                            </Button>
                            <Button variant="secondary" icon={<X className="size-4" aria-hidden="true" />} disabled={busy} onClick={() => void onReject(p.id)} id={`research-reject-${p.id}`}>
                                {t('reject')}
                            </Button>
                        </>
                    )}
                </div>
            ) : null}
        </Card>
    );
}

function RunReview({ review, ids, canEdit, kindLabels, onChanged, workspaceSlug, bookId }: { review: RunReviewView; ids: ResearchIds; canEdit: boolean; kindLabels: ResearchPageProps['kindLabels']; onChanged: () => Promise<void>; workspaceSlug: string; bookId: string }) {
    const t = useTranslations('research');
    const te = useTranslations('enrichment');
    const tFields = useTranslations('bible.fields');
    const errorText = useErrorText();
    const [busy, setBusy] = useState(false);
    const scaleOf = useCallback((n: number) => tFields('scaleOf', { value: String(n), max: 5 }), [tFields]);
    const act = async (action: () => Promise<string>): Promise<boolean> => {
        setBusy(true);
        try {
            toast.success(await action());
            await onChanged();
            return true;
        } catch (err) {
            toast.error(errorText(err));
            await onChanged();
            return false;
        } finally {
            setBusy(false);
        }
    };
    const acceptField = (p: ResearchFieldProposalView, value?: FieldValue | null) =>
        act(async () => {
            await researchApi.accept(ids, p.id, { baseVersion: p.currentVersion, reviewedCurrent: p.baseVersion !== p.currentVersion ? true : undefined, ...(value !== undefined ? { value } : {}) });
            return te('accepted');
        });
    const acceptNew = (p: ResearchNewElementView, edit?: { name: string; summary: string | null }) =>
        act(async () => {
            await researchApi.accept(ids, p.id, edit ? { name: edit.name, summary: edit.summary } : {});
            return te('acceptedNew', { name: edit?.name ?? p.name });
        });
    const reject = async (id: string) => {
        await act(async () => {
            await researchApi.reject(ids, id);
            return te('rejected');
        });
    };
    const keep = async (f: FindingView) => {
        await act(async () => {
            await researchApi.keep(ids, review.run.id, f.id);
            return t('findings.kept');
        });
    };
    return (
        <div className="space-y-section" data-testid="run-review">
            {review.findings.length > 0 ? (
                <section aria-labelledby={`findings-${review.run.id}`} className="space-y-default">
                    <h3 id={`findings-${review.run.id}`} className="text-base font-semibold text-content-emphasis">
                        {t('findings.title')}
                    </h3>
                    {review.findings.map((f) => (
                        <FindingCard key={f.id} f={f} canEdit={canEdit} busy={busy} onKeep={keep} workspaceSlug={workspaceSlug} bookId={bookId} />
                    ))}
                </section>
            ) : null}
            {review.fields.length > 0 ? (
                <section aria-labelledby={`proposals-${review.run.id}`} className="space-y-default">
                    <h3 id={`proposals-${review.run.id}`} className="text-base font-semibold text-content-emphasis">
                        {t('proposals.title')}
                    </h3>
                    {review.fields.map((p) => (
                        <FieldProposalCard key={p.id} p={p} findings={review.findings} canEdit={canEdit} busy={busy} onAccept={acceptField} onReject={reject} scaleOf={scaleOf} workspaceSlug={workspaceSlug} bookId={bookId} />
                    ))}
                </section>
            ) : null}
            {review.newElements.length > 0 ? (
                <section aria-labelledby={`new-${review.run.id}`} className="space-y-default">
                    <h3 id={`new-${review.run.id}`} className="text-base font-semibold text-content-emphasis">
                        {t('proposals.newTitle')}
                    </h3>
                    {review.newElements.map((p) => (
                        <NewElementCard key={p.id} p={p} findings={review.findings} canEdit={canEdit} busy={busy} kindLabel={kindLabels[p.newKind] ?? p.newKind} onAccept={acceptNew} onReject={reject} />
                    ))}
                </section>
            ) : null}
        </div>
    );
}

// ─── A brief ───────────────────────────────────────────────────────

function BriefCard({ brief, ids, canEdit, kindLabels, onChanged, initialReview, workspaceSlug, bookId }: { brief: BriefView; ids: ResearchIds; canEdit: boolean; kindLabels: ResearchPageProps['kindLabels']; onChanged: () => Promise<void>; initialReview: RunReviewView | null; workspaceSlug: string; bookId: string }) {
    const t = useTranslations('research.briefs');
    const tr = useTranslations('research');
    const errorText = useErrorText();
    const [busy, setBusy] = useState(false);
    const [review, setReview] = useState<RunReviewView | null>(initialReview);
    const fileRef = useRef<HTMLInputElement>(null);
    const run = brief.latestRun;
    const loadReview = useCallback(async (runId: string) => {
        try {
            setReview((await researchApi.review(ids, runId)).review);
        } catch (err) {
            toast.error(errorText(err));
        }
    }, [ids, errorText]);
    const stream = useResearchStream(live(run) ? RESEARCH_API.stream(ids, run!.id) : null, (finished) => {
        void onChanged();
        void loadReview(finished.id);
    });
    const dispatch = async () => {
        setBusy(true);
        try {
            await researchApi.dispatch(ids, brief.id);
            toast.success(t('dispatched'));
            setReview(null);
            await onChanged();
        } catch (err) {
            toast.error(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const attach = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        try {
            await researchApi.attach(ids, brief.id, file);
            toast.success(t('attached', { name: file.name }));
            await onChanged();
        } catch (err) {
            toast.error(errorText(err));
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };
    const headingId = `brief-${brief.id}-title`;
    const reviewOpen = review !== null && run !== null && review.run.id === run.id;
    return (
        <Card className="space-y-default p-5" data-testid="research-brief" data-status={brief.status} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-start justify-between gap-tight">
                <div className="min-w-0 space-y-1">
                    <h3 id={headingId} className="text-base font-semibold text-content-emphasis">
                        {brief.question}
                    </h3>
                    <p className="text-sm text-content-muted">{brief.purpose}</p>
                </div>
                <div className="flex flex-wrap items-center gap-tight">
                    <StatusBadge variant="neutral">{tr(`newBrief.depths.${brief.depth}`)}</StatusBadge>
                    <StatusBadge variant={statusVariant(brief.status)} data-testid="brief-status">
                        {tr(`status.${brief.status}`)}
                    </StatusBadge>
                </div>
            </div>
            {brief.scope.length > 0 ? <p className="text-sm text-content-default">{t('scopeLabel', { names: brief.scope.map((s) => s.name).join(', ') })}</p> : null}
            {brief.urls.length > 0 ? (
                <ul className="text-sm text-content-default" aria-label={t('urlsLabel')}>
                    {brief.urls.map((u) => (
                        <li key={u} className="break-all">
                            {u}
                        </li>
                    ))}
                </ul>
            ) : null}
            {brief.sources.length > 0 ? <p className="text-sm text-content-default">{t('files', { names: brief.sources.map((s) => s.filename).join(', ') })}</p> : null}
            {run ? <RunSummary run={run} progress={live(run) ? stream.progress : run.progress} /> : <p className="text-sm text-content-muted">{t('neverRun')}</p>}
            {canEdit ? (
                <div className="flex flex-wrap items-center gap-tight">
                    <Button variant="primary" icon={<Play className="size-4" aria-hidden="true" />} loading={busy} disabled={live(run)} onClick={() => void dispatch()} id={`run-brief-${brief.id}`}>
                        {run ? t('rerun') : t('run')}
                    </Button>
                    <Button variant="secondary" icon={<FileUp className="size-4" aria-hidden="true" />} disabled={busy || live(run)} onClick={() => fileRef.current?.click()} id={`attach-brief-${brief.id}`}>
                        {t('attach')}
                    </Button>
                    <input ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" className="sr-only" tabIndex={-1} aria-label={t('attach')} onChange={(e) => void attach(e.target.files?.[0])} data-testid={`attach-input-${brief.id}`} />
                </div>
            ) : null}
            {run && !live(run) && (run.metrics.findingsKept > 0 || run.metrics.proposalsKept > 0) ? (
                <Button variant="secondary" size="sm" onClick={() => (reviewOpen ? setReview(null) : void loadReview(run.id))} aria-expanded={reviewOpen} id={`results-brief-${brief.id}`}>
                    {reviewOpen ? t('hideResults') : t('viewResults')}
                </Button>
            ) : null}
            {reviewOpen ? <RunReview review={review!} ids={ids} canEdit={canEdit} kindLabels={kindLabels} onChanged={() => loadReview(run!.id)} workspaceSlug={workspaceSlug} bookId={bookId} /> : null}
        </Card>
    );
}

export function ResearchPage({ workspaceSlug, book, briefs: initial, truncated, elements, kindLabels, canEdit, initialReview = null }: ResearchPageProps) {
    const t = useTranslations('research');
    const [briefs, setBriefs] = useState(initial);
    const ids: ResearchIds = useMemo(() => ({ slug: workspaceSlug, bookId: book.id }), [workspaceSlug, book.id]);
    const reload = useCallback(async () => {
        try {
            setBriefs((await researchApi.briefs(ids)).briefs);
        } catch {
            // The page keeps what it has; the next action reads again.
        }
    }, [ids]);
    return (
        <EntityDetailLayout
            id="research-page"
            breadcrumbs={[{ label: book.title, href: APP_ROUTES.book(workspaceSlug, book.id) }, { label: t('title') }]}
            title={t('title')}
            meta={<span className="text-sm text-content-muted">{t('description')}</span>}
        >
            <div className="space-y-section">
                {!canEdit ? <p className="text-sm text-content-muted">{t('readOnly')}</p> : null}
                {canEdit ? <NewBriefForm ids={ids} elements={elements} kindLabels={kindLabels} onCreated={reload} /> : null}
                <section aria-labelledby="briefs-title" className="space-y-default">
                    <h2 id="briefs-title" className="text-base font-semibold text-content-emphasis">
                        {t('briefs.title')}
                    </h2>
                    {truncated ? <p className="text-sm text-content-warning">{t('briefs.truncated', { count: briefs.length })}</p> : null}
                    {briefs.length === 0 ? <EmptyState title={t('briefs.emptyTitle')} description={t('briefs.empty')} /> : null}
                    {briefs.map((b) => (
                        <BriefCard
                            key={b.id}
                            brief={b}
                            ids={ids}
                            canEdit={canEdit}
                            kindLabels={kindLabels}
                            onChanged={reload}
                            initialReview={initialReview && b.latestRun && initialReview.run.id === b.latestRun.id ? initialReview : null}
                            workspaceSlug={workspaceSlug}
                            bookId={book.id}
                        />
                    ))}
                </section>
            </div>
        </EntityDetailLayout>
    );
}
