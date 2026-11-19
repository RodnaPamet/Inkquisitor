'use client';

/**
 * Import into a book (Phase 1.3): a Markdown bundle (the export's zip) or a
 * concept note (pasted, or a .txt / .md file read as text in the browser).
 * Shown only to a viewer who may edit (`canEdit`, from the server).
 *
 * After an import the modal shows the API's REPORT — what was created,
 * updated and left unchanged, how many versions were written — and refreshes
 * the page behind it. A refused bundle shows every problem the API named, by
 * file, worded from its reason (`useImportReasonMessage`); nothing was
 * written, and the form is kept so the author can try again.
 */
import { Fragment, useEffect, useState, type ChangeEvent, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { APP_ROUTES } from '@/lib/app-routes';
import {
    BIBLE_API,
    BibleApiError,
    bibleFetch,
    bibleUpload,
    reasonOf,
    type BundleImportReport,
    type ConceptNoteReport,
    type ImportProblem,
} from '@/lib/bible/api-client';
import { BUNDLE_UPLOAD_MAX_BYTES, CONCEPT_NOTE_MAX } from '@/lib/bible/transfer-limits';
import { useImportReasonMessage } from './import-messages';

export interface ImportModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    workspaceSlug: string;
    bookId: string;
}

type Mode = 'bundle' | 'note';

type Outcome =
    | { kind: 'bundle'; report: BundleImportReport }
    | { kind: 'note'; report: ConceptNoteReport }
    | { kind: 'refused'; reason: string | null; problems: ImportProblem[]; truncated: boolean };

/** Items listed in a report, at most; the rest are counted. */
const REPORT_ITEMS_SHOWN = 50;

function refusalOf(err: unknown): Outcome {
    const details = err instanceof BibleApiError && err.details && typeof err.details === 'object' ? (err.details as { problems?: unknown; truncated?: unknown }) : {};
    const problems = Array.isArray(details.problems) ? (details.problems as ImportProblem[]) : [];
    return { kind: 'refused', reason: reasonOf(err), problems, truncated: details.truncated === true };
}

export function ImportModal({ open, setOpen, workspaceSlug, bookId }: ImportModalProps) {
    const t = useTranslations('bible.transfer');
    const reasonMessage = useImportReasonMessage();
    const router = useRouter();
    const [mode, setMode] = useState<Mode>('bundle');
    const [file, setFile] = useState<File | null>(null);
    const [applyBookDetails, setApplyBookDetails] = useState(false);
    const [noteName, setNoteName] = useState('');
    const [noteText, setNoteText] = useState('');
    const [formError, setFormError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [outcome, setOutcome] = useState<Outcome | null>(null);

    // Each opening starts clean.
    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMode('bundle');
        setFile(null);
        setApplyBookDetails(false);
        setNoteName('');
        setNoteText('');
        setFormError(null);
        setOutcome(null);
    }, [open]);

    const done = outcome !== null && outcome.kind !== 'refused';

    async function pickNoteFile(e: ChangeEvent<HTMLInputElement>) {
        const picked = e.target.files?.[0];
        if (!picked) return;
        const text = await picked.text();
        if (text.length > CONCEPT_NOTE_MAX * 4) {
            setFormError(t('noteFileTooLarge'));
            return;
        }
        setFormError(null);
        setNoteText(text);
        if (noteName.trim() === '') setNoteName(picked.name.replace(/\.(txt|md|markdown)$/i, ''));
    }

    async function submit(e: FormEvent) {
        e.preventDefault();
        setFormError(null);
        if (mode === 'bundle') {
            if (!file) return setFormError(t('bundleRequired'));
            if (file.size > BUNDLE_UPLOAD_MAX_BYTES) return setFormError(t('bundleTooLarge'));
        } else if (noteText.trim() === '') {
            return setFormError(t('noteRequired'));
        }
        setSubmitting(true);
        setOutcome(null);
        try {
            if (mode === 'bundle') {
                const { report } = await bibleUpload<{ report: BundleImportReport }>(BIBLE_API.importBundle(workspaceSlug, bookId, { applyBookDetails }), file!, 'application/zip');
                setOutcome({ kind: 'bundle', report });
            } else {
                const { report } = await bibleFetch<{ report: ConceptNoteReport }>(BIBLE_API.importConceptNote(workspaceSlug, bookId), {
                    method: 'POST',
                    body: { text: noteText, ...(noteName.trim() !== '' ? { name: noteName } : {}) },
                });
                setOutcome({ kind: 'note', report });
            }
            router.refresh();
        } catch (err) {
            setOutcome(refusalOf(err));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal showModal={open} setShowModal={setOpen} title={t('importTitle')}>
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('importTitle')} description={t('importDescription')} />
                <Modal.Body className="space-y-default">
                    {done ? null : (
                        <>
                            <ToggleGroup
                                ariaLabel={t('modeAria')}
                                options={[
                                    { value: 'bundle', label: t('modeBundle'), id: 'import-mode-bundle' },
                                    { value: 'note', label: t('modeNote'), id: 'import-mode-note' },
                                ]}
                                selected={mode}
                                selectAction={(v) => {
                                    setMode(v as Mode);
                                    setFormError(null);
                                    setOutcome(null);
                                }}
                            />
                            {mode === 'bundle' ? (
                                <Fragment key="bundle">
                                    <FormField label={t('bundleFile')} description={t('bundleFileHelp')} required>
                                        <Input
                                            id="import-bundle-file"
                                            type="file"
                                            accept=".zip,application/zip"
                                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                        />
                                    </FormField>
                                    <label htmlFor="import-apply-book-details" className="flex items-start gap-tight text-sm text-content-default">
                                        <Checkbox id="import-apply-book-details" checked={applyBookDetails} onCheckedChange={(v) => setApplyBookDetails(v === true)} />
                                        <span>{t('applyBookDetails')}</span>
                                    </label>
                                </Fragment>
                            ) : (
                                <Fragment key="note">
                                    <FormField label={t('noteName')} description={t('noteNameHelp')}>
                                        <Input id="import-note-name" value={noteName} onChange={(e) => setNoteName(e.target.value)} autoComplete="off" />
                                    </FormField>
                                    <FormField label={t('noteText')} description={t('noteTextHelp')} required>
                                        <Textarea id="import-note-text" value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={8} />
                                    </FormField>
                                    <FormField label={t('noteFile')} description={t('noteFileHelp')}>
                                        <Input id="import-note-file" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={pickNoteFile} />
                                    </FormField>
                                </Fragment>
                            )}
                        </>
                    )}
                    {formError ? (
                        <p className="text-sm text-content-error" role="alert">
                            {formError}
                        </p>
                    ) : null}
                    {outcome ? <OutcomeView outcome={outcome} workspaceSlug={workspaceSlug} bookId={bookId} reasonMessage={reasonMessage} /> : null}
                </Modal.Body>
                <Modal.Actions>
                    {done ? (
                        <Button type="button" variant="primary" onClick={() => setOpen(false)} id="import-done">
                            {t('done')}
                        </Button>
                    ) : (
                        <>
                            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                                {t('cancel')}
                            </Button>
                            <Button type="submit" variant="primary" loading={submitting} id="import-submit">
                                {t('importSubmit')}
                            </Button>
                        </>
                    )}
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}

function OutcomeView({
    outcome,
    workspaceSlug,
    bookId,
    reasonMessage,
}: {
    outcome: Outcome;
    workspaceSlug: string;
    bookId: string;
    reasonMessage: (reason: string | null) => string;
}) {
    const t = useTranslations('bible.transfer');
    if (outcome.kind === 'refused') {
        return (
            <div role="alert" className="space-y-tight" data-testid="import-refusal">
                <p className="text-sm font-medium text-content-error">{reasonMessage(outcome.reason)}</p>
                {outcome.problems.length > 0 ? (
                    <ul className="max-h-64 space-y-1 overflow-auto text-sm text-content-default">
                        {outcome.problems.map((p, i) => (
                            <li key={`${p.path}:${p.key ?? ''}:${i}`}>
                                <code className="text-xs text-content-muted">{p.path || t('wholeArchive')}</code>
                                {p.key ? <code className="ml-1 text-xs text-content-muted">({p.key})</code> : null}
                                <span className="ml-1">{reasonMessage(p.reason)}</span>
                            </li>
                        ))}
                    </ul>
                ) : null}
                {outcome.truncated ? <p className="text-xs text-content-muted">{t('problemsTruncated')}</p> : null}
            </div>
        );
    }
    if (outcome.kind === 'note') {
        const { report } = outcome;
        return (
            <div role="status" className="space-y-tight" data-testid="import-report">
                <p className="text-sm text-content-default">{t(`noteOutcome.${report.outcome}`, { name: report.element.name })}</p>
                <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, report.element.id)} className="text-sm text-content-brand hover:underline">
                    {t('openElement')}
                </Link>
            </div>
        );
    }
    const { report } = outcome;
    const shown = report.items.slice(0, REPORT_ITEMS_SHOWN);
    return (
        <div role="status" className="space-y-tight" data-testid="import-report">
            <p className="text-sm font-medium text-content-emphasis">{t('reportElements', report.elements)}</p>
            <p className="text-sm text-content-default">
                {report.versionsWritten === 0 ? t('reportVersionsNone') : report.versionsWritten === 1 ? t('reportVersionsOne') : t('reportVersions', { count: report.versionsWritten })}
            </p>
            <p className="text-sm text-content-default">{t('reportRelations', report.relations)}</p>
            {report.bookDetailsApplied ? <p className="text-sm text-content-default">{t('reportBookDetails')}</p> : null}
            {shown.length > 0 ? (
                <ul className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-auto">
                    {shown.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-tight py-1.5 text-sm">
                            <Link href={APP_ROUTES.bibleElement(workspaceSlug, bookId, item.id)} className="min-w-0 truncate text-content-default hover:underline">
                                {item.name}
                            </Link>
                            <StatusBadge variant={item.outcome === 'unchanged' ? 'neutral' : item.outcome === 'created' ? 'success' : 'info'}>{t(`outcome.${item.outcome}`)}</StatusBadge>
                        </li>
                    ))}
                </ul>
            ) : null}
            {report.items.length > shown.length ? <p className="text-xs text-content-muted">{t('reportMore', { count: report.items.length - shown.length })}</p> : null}
        </div>
    );
}
