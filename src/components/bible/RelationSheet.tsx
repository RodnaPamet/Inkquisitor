'use client';

/**
 * One relation, opened from an element's relations (Phase 3.3, decision D24):
 * its two ends and its type's label, its note, and its FIELDS — the facts a
 * relation of that type holds (how it began, what each side wants, …), from
 * the declaring kind's template. A reader reads them as text; an editor edits
 * them and saves once, against the relation's version (`baseVersion`): a newer
 * version refuses the save (409 VERSION_CONFLICT), nothing is written, and the
 * sheet offers to reload. Never retried unasked (Phase 1.H's rule).
 *
 * "Question this relation" starts an interview scoped to it (a SELECTION of
 * this one relation) through the ordinary setup sheet.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessagesSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { InterviewLauncher } from '@/components/interview/InterviewLauncher';
import { BIBLE_API, bibleFetch, reasonOf, type RelationView } from '@/lib/bible/api-client';
import type { FieldValue } from '@/lib/bible/field-values';
import { FieldEditor } from './FieldEditor';
import { useApiErrorMessage } from './error-messages';

export interface RelationSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceSlug: string;
    bookId: string;
    relationId: string | null;
    /** How the relation reads from the element it was opened on ("knows Wenna"). */
    title: string;
    canEdit: boolean;
}

function RelationBody({ workspaceSlug, bookId, relationId, canEdit }: { workspaceSlug: string; bookId: string; relationId: string; canEdit: boolean }) {
    const t = useTranslations('bible.relationSheet');
    const errorMessage = useApiErrorMessage();
    const [relation, setRelation] = useState<RelationView | null>(null);
    const [failed, setFailed] = useState(false);
    const [drafts, setDrafts] = useState<ReadonlyMap<string, FieldValue | null>>(new Map());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState(false);

    const load = useCallback(async () => {
        const { relation: fresh } = await bibleFetch<{ relation: RelationView }>(BIBLE_API.relation(workspaceSlug, bookId, relationId));
        return fresh;
    }, [workspaceSlug, bookId, relationId]);

    useEffect(() => {
        let live = true;
        load()
            .then((fresh) => live && setRelation(fresh))
            .catch(() => live && setFailed(true));
        return () => {
            live = false;
        };
    }, [load]);

    const reload = async () => {
        try {
            setRelation(await load());
            setDrafts(new Map());
            setConflict(false);
            setError(null);
        } catch {
            setFailed(true);
        }
    };

    const save = async () => {
        if (!relation || drafts.size === 0) return;
        setSaving(true);
        setError(null);
        try {
            const { relation: saved } = await bibleFetch<{ relation: RelationView }>(BIBLE_API.relationFields(workspaceSlug, bookId, relation.id), {
                method: 'PUT',
                body: { baseVersion: relation.versionNumber, fields: [...drafts].map(([key, value]) => ({ key, value })) },
            });
            setRelation(saved);
            setDrafts(new Map());
        } catch (err) {
            const reason = reasonOf(err);
            if (reason === 'VERSION_CONFLICT') setConflict(true);
            setError(errorMessage(reason));
        } finally {
            setSaving(false);
        }
    };

    if (failed) return <p className="text-sm text-content-muted">{t('loadFailed')}</p>;
    if (!relation) return <p className="text-sm text-content-muted">{t('loading')}</p>;
    return (
        <div className="space-y-default" data-testid="relation-sheet" data-relation-id={relation.id} data-version={relation.versionNumber}>
            <p className="text-sm text-content-default">
                <span className="font-medium text-content-emphasis">{relation.from.name}</span> <span className="text-content-muted">{relation.label}</span>{' '}
                <span className="font-medium text-content-emphasis">{relation.to.name}</span>
            </p>
            {relation.note ? <p className="whitespace-pre-wrap text-sm text-content-default">{relation.note}</p> : null}
            {relation.fields.length === 0 ? <p className="text-sm text-content-muted">{t('noFields')}</p> : null}
            {relation.fields.map(({ field, value }) => (
                <FieldEditor
                    key={field.key}
                    def={field}
                    value={drafts.has(field.key) ? (drafts.get(field.key) ?? null) : value}
                    readOnly={!canEdit || conflict}
                    onChange={(next) => setDrafts((d) => new Map(d).set(field.key, next))}
                />
            ))}
            {error ? (
                <p className="text-sm text-content-error" role="alert">
                    {error}
                </p>
            ) : null}
            <p className="text-xs text-content-muted">{relation.versionNumber > 0 ? t('version', { number: relation.versionNumber }) : t('noVersion')}</p>
            {canEdit ? (
                <div className="flex flex-wrap items-center gap-tight">
                    {conflict ? (
                        <Button variant="secondary" onClick={() => void reload()} id="relation-sheet-reload">
                            {t('reload')}
                        </Button>
                    ) : (
                        <Button variant="primary" loading={saving} disabled={drafts.size === 0} onClick={() => void save()} id="relation-sheet-save">
                            {t('save')}
                        </Button>
                    )}
                    <InterviewLauncher
                        workspaceSlug={workspaceSlug}
                        bookId={bookId}
                        target={{ scope: 'SELECTION', elementIds: [], relationIds: [relation.id] }}
                        title={t('questionTitle', { from: relation.from.name, label: relation.label, to: relation.to.name })}
                        label={t('question')}
                        icon={<MessagesSquare className="size-4" aria-hidden="true" />}
                        id="relation-sheet-question"
                    />
                </div>
            ) : null}
        </div>
    );
}

export function RelationSheet({ open, onOpenChange, workspaceSlug, bookId, relationId, title, canEdit }: RelationSheetProps) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange} size="md" title={title}>
            <Sheet.Body>{open && relationId ? <RelationBody key={relationId} workspaceSlug={workspaceSlug} bookId={bookId} relationId={relationId} canEdit={canEdit} /> : null}</Sheet.Body>
        </Sheet>
    );
}
