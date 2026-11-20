'use client';

/**
 * The type picker (Phase 3.2): an arrow drawn between two nodes the book does
 * not relate yet asks how they are related. It offers only what the two
 * kinds' templates declare, plus "related to" (`relationPickerChoices`), each
 * read as a sentence from the arrow's start; picking one creates the
 * BibleRelation through the bible's own route, and the host then draws it.
 *
 * A refusal is worded from its reason (`bible.errors`), never the server's
 * English. Cancel drops the arrow: an arrow is a gesture, not a note. The
 * host mounts one picker per arrow, so its state starts afresh each time.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useApiErrorMessage } from '@/components/bible/error-messages';
import { BIBLE_API, bibleFetch, reasonOf, type CreatedRelationView } from '@/lib/bible/api-client';
import type { PickerChoice } from '@/lib/canvas/relation-picker';

export interface RelationTypePickerProps {
    open: boolean;
    workspaceSlug: string;
    bookId: string;
    /** The arrow's two elements, by name: "<a> … <b>". */
    names: { a: string; b: string };
    choices: readonly PickerChoice[];
    /** The relation was created. */
    onCreated: (relation: CreatedRelationView) => void;
    /** Closed without a relation (cancel, Escape, a click outside). */
    onCancel: () => void;
}

export function RelationTypePicker({ open, workspaceSlug, bookId, names, choices, onCreated, onCancel }: RelationTypePickerProps) {
    const t = useTranslations('canvas.picker');
    const errorMessage = useApiErrorMessage();
    const [choiceId, setChoiceId] = useState<string>(choices[0]?.id ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const groupId = useId();

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        const choice = choices.find((c) => c.id === choiceId);
        if (!choice || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const { relation } = await bibleFetch<{ relation: CreatedRelationView }>(BIBLE_API.relations(workspaceSlug, bookId), {
                method: 'POST',
                body: { fromElementId: choice.fromElementId, toElementId: choice.toElementId, type: choice.type },
            });
            onCreated(relation);
        } catch (err) {
            setError(errorMessage(reasonOf(err)));
            setSubmitting(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => {
                if (!next && !submitting) onCancel();
            }}
            title={t('title')}
        >
            <Modal.Form onSubmit={submit}>
                <Modal.Header title={t('title')} description={t('description', { a: names.a, b: names.b })} />
                <Modal.Body className="space-y-default">
                    {choices.length === 0 ? (
                        <p className="text-sm text-content-muted" data-testid="relation-type-picker-none">
                            {t('none')}
                        </p>
                    ) : (
                        <RadioGroup value={choiceId} onValueChange={setChoiceId} aria-label={t('typeLabel')} className="space-y-tight" data-testid="relation-type-picker">
                            {choices.map((c) => (
                                <div key={c.id} className="flex items-center gap-tight">
                                    <RadioGroupItem value={c.id} id={`${groupId}-${c.id}`} />
                                    <Label htmlFor={`${groupId}-${c.id}`} className="font-normal">
                                        {t('sentence', { a: names.a, label: c.label, b: names.b })}
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                    )}
                    {error ? (
                        <p className="text-sm text-content-error" role="alert">
                            {error}
                        </p>
                    ) : null}
                </Modal.Body>
                <Modal.Actions>
                    <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting} id="relation-picker-cancel">
                        {t('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" loading={submitting} disabled={choices.length === 0} id="relation-picker-submit">
                        {t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
