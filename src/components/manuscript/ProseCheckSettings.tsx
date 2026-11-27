'use client';

/**
 * The book's PROSE CHECKS settings (Phase 5.2, D34), below the manuscript's
 * outline: the style sheet the checks read (a link to its STYLE element, or how
 * to make one), the rules — each on or off for the book —, the
 * inclusive-language check (off until the author turns it on, and never applied
 * to speech), the notes the author dismissed (all of them can be brought back),
 * and the book's character names that look or sound alike.
 *
 * Banned and favoured words, the tense, person, spelling and speech marks are
 * the STYLE element's fields, edited on its page like every bible entry. A
 * reader reads the settings as text.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { APP_ROUTES } from '@/lib/app-routes';
import { bibleFetch } from '@/lib/bible/api-client';
import { MANUSCRIPT_API } from '@/lib/manuscript/api-client';
import { TOGGLEABLE_RULE_IDS, type ProseCheckSettingsView, type ProseRuleId } from '@/lib/prose-checks/vocabulary';

export interface ProseCheckSettingsProps {
    workspaceSlug: string;
    bookId: string;
    canEdit: boolean;
}

export function ProseCheckSettings({ workspaceSlug, bookId, canEdit }: ProseCheckSettingsProps) {
    const t = useTranslations('manuscript.proseChecks');
    const [view, setView] = useState<ProseCheckSettingsView | null>(null);
    const [error, setError] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let live = true;
        bibleFetch<ProseCheckSettingsView>(MANUSCRIPT_API.proseSettings(workspaceSlug, bookId))
            .then((v) => {
                if (live) setView(v);
            })
            .catch(() => {
                if (live) setError(true);
            });
        return () => {
            live = false;
        };
    }, [workspaceSlug, bookId]);

    const save = useCallback(
        async (next: { alexEnabled: boolean; rulesOff: ProseRuleId[] }) => {
            setSaving(true);
            setError(false);
            try {
                setView(await bibleFetch<ProseCheckSettingsView>(MANUSCRIPT_API.proseSettings(workspaceSlug, bookId), { method: 'PUT', body: next }));
            } catch {
                setError(true);
            } finally {
                setSaving(false);
            }
        },
        [workspaceSlug, bookId],
    );

    const clearDismissals = useCallback(async () => {
        setSaving(true);
        try {
            await bibleFetch(MANUSCRIPT_API.proseDismissals(workspaceSlug, bookId), { method: 'DELETE' });
            setView((v) => (v ? { ...v, dismissals: 0 } : v));
        } catch {
            setError(true);
        } finally {
            setSaving(false);
        }
    }, [workspaceSlug, bookId]);

    return (
        <section aria-labelledby="prose-check-settings-title" data-testid="prose-check-settings">
            <Card className="space-y-default p-4">
                <div className="space-y-tight">
                    <h2 id="prose-check-settings-title" className="text-lg font-semibold text-content-emphasis">
                        {t('settings.title')}
                    </h2>
                    <p className="text-sm text-content-muted">{t('settings.help')}</p>
                </div>
                {!view ? (
                    <p className="text-sm text-content-muted" role="status">
                        {error ? t('settings.loadError') : t('settings.loading')}
                    </p>
                ) : (
                    <>
                        <p className="text-sm text-content-default" data-testid="prose-style-sheet">
                            {view.styleSheet ? (
                                <>
                                    {t('settings.sheet')}{' '}
                                    <Link className="font-medium text-content-brand hover:underline" href={APP_ROUTES.bibleElement(workspaceSlug, bookId, view.styleSheet.elementId)}>
                                        {view.styleSheet.name}
                                    </Link>
                                </>
                            ) : (
                                t('settings.noSheet')
                            )}
                        </p>

                        <fieldset className="space-y-tight">
                            <legend className="text-sm font-medium text-content-emphasis">{t('settings.rules')}</legend>
                            <ul className="grid gap-tight sm:grid-cols-2">
                                {TOGGLEABLE_RULE_IDS.map((rule) => {
                                    const on = !view.rulesOff.includes(rule);
                                    return (
                                        <li key={rule} className="flex items-start gap-tight">
                                            {canEdit ? (
                                                <Checkbox
                                                    id={`prose-rule-${rule}`}
                                                    checked={on}
                                                    disabled={saving}
                                                    onCheckedChange={(v) =>
                                                        void save({ alexEnabled: view.alexEnabled, rulesOff: v === true ? view.rulesOff.filter((r) => r !== rule) : [...view.rulesOff, rule] })
                                                    }
                                                />
                                            ) : null}
                                            <label htmlFor={canEdit ? `prose-rule-${rule}` : undefined} className="text-sm text-content-default">
                                                {t(`rules.${rule}.name`)}
                                                {canEdit ? null : <span className="text-content-muted"> · {on ? t('settings.on') : t('settings.off')}</span>}
                                                <span className="block text-xs text-content-muted">{t(`rules.${rule}.about`)}</span>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>
                        </fieldset>

                        <div className="flex items-start gap-tight">
                            {canEdit ? (
                                <Checkbox id="prose-alex" checked={view.alexEnabled} disabled={saving} onCheckedChange={(v) => void save({ alexEnabled: v === true, rulesOff: view.rulesOff })} />
                            ) : null}
                            <label htmlFor={canEdit ? 'prose-alex' : undefined} className="text-sm text-content-default">
                                {t('rules.inclusive-language.name')}
                                {canEdit ? null : <span className="text-content-muted"> · {view.alexEnabled ? t('settings.on') : t('settings.off')}</span>}
                                <span className="block text-xs text-content-muted">{t('settings.alexHelp')}</span>
                            </label>
                        </div>

                        <div className="flex flex-wrap items-center gap-default text-sm text-content-default">
                            <span data-testid="prose-dismissals">{t('settings.dismissals', { count: view.dismissals })}</span>
                            {canEdit && view.dismissals > 0 ? (
                                <Button variant="secondary" size="sm" icon={<RotateCcw className="size-4" aria-hidden="true" />} onClick={() => void clearDismissals()} disabled={saving} id="prose-clear-dismissals">
                                    {t('settings.clearDismissals')}
                                </Button>
                            ) : null}
                        </div>

                        <div className="space-y-tight">
                            <h3 className="text-sm font-medium text-content-emphasis">{t('settings.similarNames')}</h3>
                            {view.similarNames.length === 0 ? (
                                <p className="text-sm text-content-muted">{t('settings.similarNone')}</p>
                            ) : (
                                <ul className="space-y-tight text-sm text-content-default" data-testid="prose-similar-names">
                                    {view.similarNames.map((p) => (
                                        <li key={`${p.a.id}-${p.b.id}`}>
                                            {t('settings.similarPair', { a: p.a.name, b: p.b.name })} <span className="text-content-muted">· {t(`settings.why.${p.why}`)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {view.similarNamesCut ? <p className="text-xs text-content-muted">{t('settings.similarCut')}</p> : null}
                        </div>
                        {error ? (
                            <p className="text-sm text-content-error" role="alert">
                                {t('settings.saveError')}
                            </p>
                        ) : null}
                    </>
                )}
            </Card>
        </section>
    );
}
