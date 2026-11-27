'use client';

/**
 * Import a manuscript (Phase 5.1, D33): a Word (.docx) or Markdown file, split
 * at its headings — and only once the author has confirmed the split.
 *
 *   1. pick the file → the server reads it (virus scan, 4.0's reader) and
 *      answers its outline and a proposed split; nothing is written
 *   2. adjust: which heading level starts a part, a chapter, a scene; whether a
 *      scene break (`***`, a rule) starts a scene; any single heading made a
 *      part, chapter, scene or plain text (no break). The counts follow live
 *      (from the outline; scene breaks are counted by the server)
 *   3. confirm → the same file is sent again with the plan; the server writes
 *      the whole split in one transaction, or refuses it with a reason
 *
 * The file is never stored and is not added to the source library (D33 item 3).
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { reasonOf } from '@/lib/bible/api-client';
import { planSummary, type ImportPlan } from '@/lib/manuscript/import-split';
import { MANUSCRIPT_API, uploadManuscript, type ImportPreviewView } from '@/lib/manuscript/api-client';
import { IMPORT_ROLES, type ImportRole } from '@/lib/manuscript/vocabulary';
import { useManuscriptReason } from './messages';

/** Headings the adjust step lists one by one (the rest follow the levels). */
export const IMPORT_HEADINGS_SHOWN = 400;

export interface ImportManuscriptModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    workspaceSlug: string;
    bookId: string;
    onImported: (result: { scenes: number; firstSceneId: string | null }) => void;
}

type LevelKey = 'part' | 'chapter' | 'scene';

export function ImportManuscriptModal({ open, setOpen, workspaceSlug, bookId, onImported }: ImportManuscriptModalProps) {
    const t = useTranslations('manuscript.import');
    const reasonText = useManuscriptReason();
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<ImportPreviewView | null>(null);
    const [plan, setPlan] = useState<ImportPlan | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function reset() {
        setFile(null);
        setPreview(null);
        setPlan(null);
        setError(null);
        setBusy(false);
    }

    async function readFile() {
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const { preview: p } = await uploadManuscript<{ preview: ImportPreviewView }>(MANUSCRIPT_API.importPreview(workspaceSlug, bookId), file);
            setPreview(p);
            setPlan(p.plan);
        } catch (err) {
            setError(reasonText(reasonOf(err)));
        } finally {
            setBusy(false);
        }
    }

    async function confirm() {
        if (!file || !preview || !plan) return;
        setBusy(true);
        setError(null);
        try {
            const { imported } = await uploadManuscript<{ imported: { scenes: number; firstSceneId: string | null } }>(MANUSCRIPT_API.importConfirm(workspaceSlug, bookId), file, {
                ...plan,
                token: preview.token,
                issuedAt: preview.issuedAt,
            });
            onImported(imported);
            reset();
            setOpen(false);
        } catch (err) {
            setError(reasonText(reasonOf(err)));
            setBusy(false);
        }
    }

    const summary = useMemo(() => (preview && plan ? planSummary(preview.outline, plan) : null), [preview, plan]);
    const levelOptions: ComboboxOption[] = useMemo(
        () => [{ value: 'none', label: t('levelNone') }, ...(preview?.outline.levels ?? []).map((l) => ({ value: String(l), label: t('levelHeading', { level: l }) }))],
        [preview, t],
    );
    const overrides = useMemo(() => new Map(plan?.overrides ?? []), [plan]);

    function setLevel(key: LevelKey, value: string) {
        if (!plan) return;
        const level = value === 'none' ? null : Number(value);
        const levels = { ...plan.levels };
        // A level is one role at most: taking it from another role clears that one.
        for (const k of ['part', 'chapter', 'scene'] as const) if (k !== key && levels[k] === level && level !== null) levels[k] = null;
        levels[key] = level;
        setPlan({ ...plan, levels });
    }

    function roleFor(index: number, level: number): ImportRole {
        const o = overrides.get(index);
        if (o) return o;
        if (!plan) return 'text';
        return level === plan.levels.part ? 'part' : level === plan.levels.chapter ? 'chapter' : level === plan.levels.scene ? 'scene' : 'text';
    }

    function setRole(index: number, level: number, role: ImportRole) {
        if (!plan) return;
        const byLevel: ImportRole = level === plan.levels.part ? 'part' : level === plan.levels.chapter ? 'chapter' : level === plan.levels.scene ? 'scene' : 'text';
        const next = new Map(overrides);
        if (role === byLevel) next.delete(index);
        else next.set(index, role);
        setPlan({ ...plan, overrides: [...next.entries()].sort((a, b) => a[0] - b[0]) });
    }

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                const next = typeof v === 'function' ? v(open) : v;
                if (!next) reset();
                setOpen(next);
            }}
            title={t('title')}
            size="lg"
        >
            <Modal.Header title={t('title')} description={t('description')} />
            <Modal.Body className="space-y-default">
                {!preview ? (
                    <FormField label={t('file')} description={t('fileHelp')}>
                        <input
                            id="manuscript-import-file"
                            type="file"
                            accept=".docx,.md,.markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown"
                            className="block text-sm text-content-default"
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                    </FormField>
                ) : (
                    <div className="space-y-default" data-testid="manuscript-import-preview">
                        <p className="text-sm text-content-default">
                            {t('read', { words: preview.outline.words, headings: preview.outline.headings.length, breaks: preview.outline.sceneBreaks })}
                        </p>
                        <div className="grid gap-default sm:grid-cols-3">
                            {(['part', 'chapter', 'scene'] as const).map((key) => (
                                <FormField key={key} label={t(`level.${key}`)}>
                                    <Combobox
                                        id={`manuscript-import-level-${key}`}
                                        options={levelOptions}
                                        selected={levelOptions.find((o) => o.value === String(plan?.levels[key] ?? 'none')) ?? levelOptions[0]}
                                        setSelected={(o) => setLevel(key, o?.value ?? 'none')}
                                        hideSearch
                                        matchTriggerWidth
                                    />
                                </FormField>
                            ))}
                        </div>
                        <div className="flex items-center gap-tight">
                            <Checkbox
                                id="manuscript-import-breaks"
                                checked={plan?.sceneBreaks ?? false}
                                onCheckedChange={(v) => plan && setPlan({ ...plan, sceneBreaks: v === true })}
                                disabled={preview.outline.sceneBreaks === 0}
                            />
                            <Label htmlFor="manuscript-import-breaks">{t('sceneBreaks', { count: preview.outline.sceneBreaks })}</Label>
                        </div>
                        {summary ? (
                            <p className="text-sm font-medium text-content-emphasis" data-testid="manuscript-import-summary" role="status">
                                {t('summary', { parts: summary.parts, chapters: summary.chapters, scenes: summary.scenes })}
                                {plan?.sceneBreaks && preview.outline.sceneBreaks > 0 ? ` ${t('summaryBreaks', { count: preview.outline.sceneBreaks })}` : ''}
                            </p>
                        ) : null}
                        {preview.existing.scenes > 0 ? <p className="text-sm text-content-muted">{t('appends', { scenes: preview.existing.scenes })}</p> : null}
                        <ol className="max-h-80 space-y-tight overflow-y-auto" aria-label={t('headings')} data-testid="manuscript-import-headings">
                            {preview.outline.headings.slice(0, IMPORT_HEADINGS_SHOWN).map((h) => (
                                <li key={h.index} className="flex flex-wrap items-center justify-between gap-tight border-b border-border-subtle py-1">
                                    <span className="min-w-0 text-sm text-content-default" style={{ paddingLeft: `${(h.level - 1) * 0.75}rem` }}>
                                        {h.text} <span className="text-xs text-content-muted">· {t('sectionWords', { count: h.sectionWords })}</span>
                                    </span>
                                    <ToggleGroup
                                        size="sm"
                                        layout={false}
                                        ariaLabel={t('roleOf', { heading: h.text })}
                                        options={IMPORT_ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))}
                                        selected={roleFor(h.index, h.level)}
                                        selectAction={(r) => setRole(h.index, h.level, r as ImportRole)}
                                    />
                                </li>
                            ))}
                        </ol>
                        {preview.outline.headings.length > IMPORT_HEADINGS_SHOWN ? <p className="text-xs text-content-muted">{t('moreHeadings', { count: preview.outline.headings.length - IMPORT_HEADINGS_SHOWN })}</p> : null}
                    </div>
                )}
                {error ? (
                    <p className="text-sm text-content-error" role="alert" data-testid="manuscript-import-error">
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Actions>
                <Button type="button" variant="secondary" onClick={() => (preview ? reset() : setOpen(false))}>
                    {preview ? t('back') : t('cancel')}
                </Button>
                {!preview ? (
                    <Button type="button" variant="primary" icon={<Upload className="size-4" aria-hidden="true" />} disabled={!file} loading={busy} onClick={() => void readFile()} id="manuscript-import-read">
                        {t('readFile')}
                    </Button>
                ) : (
                    <Button type="button" variant="primary" loading={busy} disabled={!summary || summary.scenes + (plan?.sceneBreaks ? preview.outline.sceneBreaks : 0) === 0} onClick={() => void confirm()} id="manuscript-import-confirm">
                        {t('confirm')}
                    </Button>
                )}
            </Modal.Actions>
        </Modal>
    );
}
