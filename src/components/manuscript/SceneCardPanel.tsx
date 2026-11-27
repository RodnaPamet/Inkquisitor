'use client';

/**
 * A scene's CARD in the scene editor's panel (Phase 5.3, D35): what the scene is for — the point-of-view character's
 * goal, the conflict in the way, the outcome, what changed. Never the scene's prose (D3).
 *
 *   edit      the four fields, saved together by an explicit Save naming the card's version (a card saved elsewhere
 *             meanwhile is refused VERSION_CONFLICT: the author reloads, nothing is overwritten unasked)
 *   history   the card's latest versions, each the author's own edit or an accepted interview proposal
 *   grill     "Grill me on this scene": a scene-scoped interview asking about the card's fields; its proposals are
 *             reviewed like any other, and only an accepted one changes the card
 *
 * A reader reads the card as text.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { APP_ROUTES } from '@/lib/app-routes';
import { reasonOf } from '@/lib/bible/api-client';
import { draftApi } from '@/lib/draft-facts/api-client';
import { CODE_SETUP_DEFAULTS, interviewSetupQuery } from '@/lib/interview/setup';
import { SCENE_CARD_FIELDS, SCENE_CARD_FIELD_KEYS, type SceneCardFieldKey, type SceneCardValues, type SceneCardView } from '@/lib/manuscript/scene-card';

export interface SceneCardPanelProps {
    workspaceSlug: string;
    bookId: string;
    sceneId: string;
    canEdit: boolean;
}

type Draft = Record<SceneCardFieldKey, string>;

const asDraft = (card: SceneCardValues): Draft => ({ goal: card.goal ?? '', conflict: card.conflict ?? '', outcome: card.outcome ?? '', change: card.change ?? '' });
const asValues = (d: Draft): SceneCardValues => ({ goal: d.goal.trim() || null, conflict: d.conflict.trim() || null, outcome: d.outcome.trim() || null, change: d.change.trim() || null });

export function SceneCardPanel({ workspaceSlug, bookId, sceneId, canEdit }: SceneCardPanelProps) {
    const t = useTranslations('manuscript.card');
    const [card, setCard] = useState<SceneCardView | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'conflict' | 'error'>('loading');

    const load = useCallback(async () => {
        try {
            const { card: fresh } = await draftApi.sceneCard(workspaceSlug, bookId, sceneId);
            setCard(fresh);
            setDraft(asDraft(fresh));
            setState('ready');
        } catch {
            setState('error');
        }
    }, [workspaceSlug, bookId, sceneId]);

    // Open: read after a tick, never inside the effect's own turn.
    useEffect(() => {
        const opening = setTimeout(() => void load(), 0);
        return () => clearTimeout(opening);
    }, [load]);

    const save = async () => {
        if (!card || !draft) return;
        setState('saving');
        try {
            const { card: saved } = await draftApi.saveSceneCard(workspaceSlug, bookId, sceneId, card.version, asValues(draft));
            setCard(saved);
            setDraft(asDraft(saved));
            setState('saved');
        } catch (err) {
            setState(reasonOf(err) === 'VERSION_CONFLICT' ? 'conflict' : 'error');
        }
    };

    const grill = APP_ROUTES.newInterview(workspaceSlug, bookId, interviewSetupQuery({ scope: 'SCENE', sceneId }, { ...CODE_SETUP_DEFAULTS, personaKeys: [] }));
    const dirty = card && draft ? SCENE_CARD_FIELD_KEYS.some((k) => (draft[k].trim() || null) !== card[k]) : false;

    return (
        <Card className="space-y-default p-4" data-testid="scene-card">
            <p className="text-sm text-content-muted">{t('help')}</p>
            {state === 'loading' ? <p className="text-sm text-content-muted">{t('loading')}</p> : null}
            {card && draft
                ? SCENE_CARD_FIELDS.map((f) => {
                      const key = f.key as SceneCardFieldKey;
                      return canEdit ? (
                          <FormField key={key} label={t(`field.${key}`)} description={t(`help_${key}`)}>
                              <Textarea id={`scene-card-${key}`} value={draft[key]} rows={2} onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))} />
                          </FormField>
                      ) : (
                          <div key={key} className="space-y-tight" data-testid={`scene-card-value-${key}`}>
                              <p className="text-sm font-medium text-content-emphasis">{t(`field.${key}`)}</p>
                              <p className="text-sm text-content-default">{card[key] ?? t('empty')}</p>
                          </div>
                      );
                  })
                : null}
            {state === 'conflict' ? (
                <div className="space-y-tight rounded-md border border-border-default bg-bg-warning p-3" role="alert" data-testid="scene-card-conflict">
                    <p className="text-sm text-content-default">{t('conflict')}</p>
                    <Button variant="secondary" size="sm" onClick={() => void load()} id="scene-card-reload">
                        {t('reload')}
                    </Button>
                </div>
            ) : null}
            {state === 'error' ? (
                <p className="text-sm text-content-error" role="alert">
                    {t('error')}
                </p>
            ) : null}
            {canEdit && card ? (
                <div className="flex flex-wrap items-center gap-tight">
                    <Button variant="primary" size="sm" loading={state === 'saving'} disabled={!dirty} onClick={() => void save()} id="scene-card-save">
                        {t('save')}
                    </Button>
                    {state === 'saved' ? (
                        <span role="status" className="text-xs text-content-muted">
                            {t('saved')}
                        </span>
                    ) : null}
                    <Link href={grill} className={buttonVariants({ variant: 'secondary', size: 'sm' })} id="scene-grill" data-testid="scene-grill">
                        {t('grill')}
                    </Link>
                </div>
            ) : null}
            {card && card.versions.length > 0 ? (
                <div className="space-y-tight" data-testid="scene-card-versions">
                    <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">{t('history')}</p>
                    <ul className="space-y-tight text-xs text-content-muted">
                        {card.versions.map((v) => (
                            <li key={v.versionNumber}>{t('version', { number: v.versionNumber, source: t(`source.${v.source}`), when: new Date(v.createdAt).toLocaleString() })}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </Card>
    );
}
