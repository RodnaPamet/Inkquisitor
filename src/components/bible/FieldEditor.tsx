'use client';

/**
 * One template field of a bible element, edited with the primitive its type
 * calls for (Phase 1.2):
 *
 *   text       <Input>, one line
 *   richtext   <RichTextEditor> (HTML); the editor's markdown mode is sent
 *              as escaped paragraphs, so the stored value is always HTML
 *   list       one <Input> per item, add and remove
 *   choice     <Combobox> over the template's options
 *   scale      <ToggleGroup> over 1..5, the template's anchors at each end
 *
 * The editor owns what is on screen; every change is reported through
 * `onChange` with the value as the fields API takes it (`null` clears the
 * field). A read-only field (a READER) is shown as text, never as a disabled
 * control that could still emit an edit.
 */
import dynamic from 'next/dynamic';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { htmlToLines } from '@/components/ui/VersionDiff';
import type { RichTextContentType } from '@/components/ui/RichTextEditor';
import type { FieldValue } from '@/lib/bible/field-values';
import type { FieldDef } from '@/lib/bible/template-schema';
import { escapeHtml } from '@/lib/bible/snapshot-text';

// Tiptap and ProseMirror are large; they load only on a page that edits rich text.
const RichTextEditor = dynamic(() => import('@/components/ui/RichTextEditor').then((m) => m.RichTextEditor), {
    ssr: false,
    loading: () => <div className="h-40 animate-pulse rounded-lg border border-border-subtle bg-bg-subtle" aria-hidden="true" />,
});

/** The scale's steps; the API holds a scale to SCALE_MIN..SCALE_MAX (1..5, `src/lib/bible/field-values.ts`). */
export const SCALE_STEPS = ['1', '2', '3', '4', '5'] as const;

export interface FieldEditorProps {
    def: FieldDef;
    value: FieldValue | null;
    onChange: (value: FieldValue | null) => void;
    readOnly: boolean;
    /** The API refused this field's last value. */
    refused?: boolean;
}

/** Markdown-mode text as the HTML the field stores: one escaped paragraph per blank-line block. */
export function plainTextToHtml(text: string): string {
    return text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function FieldEditor({ def, value, onChange, readOnly, refused }: FieldEditorProps) {
    const t = useTranslations('bible.fields');
    const labelId = useId();
    const error = refused ? t('refused') : undefined;

    if (readOnly) {
        return (
            <div className="space-y-tight" data-field-key={def.key}>
                <p className="text-sm font-medium text-content-emphasis" id={labelId}>
                    {def.label}
                </p>
                <ReadOnlyValue def={def} value={value} />
            </div>
        );
    }

    switch (def.type) {
        case 'text':
            return (
                <div data-field-key={def.key}>
                    <FormField label={def.label} description={def.help} error={error}>
                        <Input
                            value={typeof value === 'string' ? value : ''}
                            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
                            data-testid={`field-input-${def.key}`}
                        />
                    </FormField>
                </div>
            );
        case 'richtext':
            return (
                <FieldShell def={def} labelId={labelId} error={error}>
                    <RichTextField value={typeof value === 'string' ? value : ''} onChange={onChange} fieldKey={def.key} />
                </FieldShell>
            );
        case 'list':
            return (
                <FieldShell def={def} labelId={labelId} error={error}>
                    <ListField items={Array.isArray(value) ? value : []} onChange={onChange} fieldKey={def.key} label={def.label} />
                </FieldShell>
            );
        case 'choice': {
            const options: ComboboxOption[] = def.options.map((o) => ({ value: o.value, label: o.label }));
            const selected = options.find((o) => o.value === value) ?? null;
            return (
                <div className="flex items-end gap-tight" data-field-key={def.key}>
                    <div className="min-w-0 flex-1">
                        <FormField label={def.label} description={def.help} error={error}>
                            <Combobox
                                options={options}
                                selected={selected}
                                setSelected={(o) => onChange(o ? o.value : null)}
                                placeholder={t('choose')}
                                searchPlaceholder={t('searchOptions')}
                                matchTriggerWidth
                            />
                        </FormField>
                    </div>
                    {selected ? <ClearButton label={t('clear', { field: def.label })} onClear={() => onChange(null)} /> : null}
                </div>
            );
        }
        case 'scale': {
            const current = typeof value === 'number' ? String(value) : null;
            return (
                <FieldShell def={def} labelId={labelId} error={error}>
                    <div className="flex flex-wrap items-center gap-default">
                        <span className="text-xs text-content-muted">{def.scaleLabels.low}</span>
                        <ToggleGroup
                            ariaLabel={def.label}
                            options={SCALE_STEPS.map((s) => ({ value: s, label: s }))}
                            selected={current}
                            selectAction={(s) => onChange(Number(s))}
                        />
                        <span className="text-xs text-content-muted">{def.scaleLabels.high}</span>
                        {current ? <ClearButton label={t('clear', { field: def.label })} onClear={() => onChange(null)} /> : null}
                    </div>
                </FieldShell>
            );
        }
    }
}

/** A labelled group for the field types that are not one form control. */
function FieldShell({ def, labelId, error, children }: { def: FieldDef; labelId: string; error?: string; children: React.ReactNode }) {
    const helpId = `${labelId}-help`;
    return (
        <div role="group" aria-labelledby={labelId} aria-describedby={helpId} className="space-y-tight" data-field-key={def.key}>
            <p className="text-sm font-medium text-content-emphasis" id={labelId}>
                {def.label}
            </p>
            <p className="text-xs text-content-muted" id={helpId}>
                {def.help}
            </p>
            {children}
            {error ? (
                <p className="text-xs text-content-error" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

function ClearButton({ label, onClear }: { label: string; onClear: () => void }) {
    return <Button variant="secondary" size="sm" icon={<X className="size-3.5" aria-hidden="true" />} aria-label={label} onClick={onClear} />;
}

/**
 * Labelled by its `FieldShell` group.
 *
 * The editor reports EDITS through `onChange` and a switch between its two
 * modes through `onModeChange` (Phase 1.H, #19: the primitive no longer
 * reports a switch as an edit). A switch saves nothing: on the way to
 * markdown mode the field shows the editor's plain text; coming back without
 * having typed in markdown mode puts the field's own HTML back, in a fresh
 * editor, with focus returned to its mode toggle. Only a change saves, and a
 * report of the HTML the field already holds is not a change.
 */
function RichTextField({ value, onChange, fieldKey }: { value: string; onChange: (v: string | null) => void; fieldKey: string }) {
    const [draft, setDraft] = useState<{ value: string; type: RichTextContentType }>({ value, type: 'HTML' });
    // The HTML the field holds: as loaded, then as last sent.
    const html = useRef(value);
    const typedInMarkdown = useRef(false);
    const [generation, setGeneration] = useState(0);
    const container = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (generation > 0) container.current?.querySelector<HTMLElement>('[data-testid="rich-text-editor-toggle"]')?.focus();
    }, [generation]);
    return (
        <div data-testid={`field-richtext-${fieldKey}`} ref={container}>
            <RichTextEditor
                key={generation}
                value={draft.value}
                contentType={draft.type}
                minHeightPx={140}
                onModeChange={(type, converted) => {
                    if (type === 'MARKDOWN') {
                        typedInMarkdown.current = false;
                        setDraft({ value: converted, type });
                    } else if (!typedInMarkdown.current) {
                        // Nothing typed in markdown: the field's own HTML, formatting and all.
                        if (draft.value !== html.current) setGeneration((g) => g + 1);
                        setDraft({ value: html.current, type });
                    } else {
                        setDraft({ value: converted, type });
                    }
                }}
                onChange={(next, type) => {
                    if (type === 'MARKDOWN') typedInMarkdown.current = true;
                    setDraft({ value: next, type });
                    const out = type === 'HTML' ? next : plainTextToHtml(next);
                    if (out === html.current) return;
                    html.current = out;
                    onChange(htmlToLines(out) === '' ? null : out);
                }}
            />
        </div>
    );
}

function ListField({ items, onChange, fieldKey, label }: { items: string[]; onChange: (v: string[] | null) => void; fieldKey: string; label: string }) {
    const t = useTranslations('bible.fields');
    // Rows on screen, blanks included; what is sent leaves the blanks out.
    const [rows, setRows] = useState<string[]>(items.length > 0 ? items : []);
    const emit = (next: string[]) => {
        setRows(next);
        const kept = next.map((s) => s.trim()).filter((s) => s !== '');
        onChange(kept.length > 0 ? kept : null);
    };
    return (
        <div className="space-y-tight" data-testid={`field-list-${fieldKey}`}>
            {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-tight">
                    <Input
                        value={row}
                        aria-label={t('listItem', { field: label, index: i + 1 })}
                        onChange={(e) => emit(rows.map((r, j) => (j === i ? e.target.value : r)))}
                    />
                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<X className="size-3.5" aria-hidden="true" />}
                        aria-label={t('removeItem', { index: i + 1 })}
                        onClick={() => emit(rows.filter((_, j) => j !== i))}
                    />
                </div>
            ))}
            <Button variant="secondary" size="sm" icon={<Plus className="size-3.5" aria-hidden="true" />} onClick={() => setRows([...rows, ''])}>
                {t('addItem')}
            </Button>
        </div>
    );
}

function ReadOnlyValue({ def, value }: { def: FieldDef; value: FieldValue | null }) {
    const t = useTranslations('bible.fields');
    if (value === null || (Array.isArray(value) && value.length === 0)) {
        return <p className="text-sm text-content-muted">{t('empty')}</p>;
    }
    if (Array.isArray(value)) {
        return (
            <ul className="list-disc space-y-tight pl-5 text-sm text-content-default">
                {value.map((item, i) => (
                    <li key={i}>{item}</li>
                ))}
            </ul>
        );
    }
    let text: string;
    if (def.type === 'richtext' && typeof value === 'string') text = htmlToLines(value);
    else if (def.type === 'choice') text = def.options.find((o) => o.value === value)?.label ?? String(value);
    else if (def.type === 'scale') text = t('scaleValue', { value: String(value), max: SCALE_STEPS.length, low: def.scaleLabels.low, high: def.scaleLabels.high });
    else text = String(value);
    return <p className="whitespace-pre-wrap text-sm text-content-default">{text}</p>;
}
