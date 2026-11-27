/**
 * "How Inkquisitor uses AI" (Phase 5.H-a, roadmap 5.H item 5: D3 re-verified by a written statement IN THE PRODUCT).
 * The wording lives in `messages/en.json` (`aiUse`) and is rendered as text; `tests/rendered/ai-use-statement.test.tsx`
 * holds that it renders and says no model writes or rewrites manuscript prose, and the D3 guard
 * (`tests/guards/scene-text-stays-off-the-model-path.test.ts`) holds the product to it. Every reader sees it.
 */
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';

/** The statement's points, in order (each a key under `aiUse.points`). */
export const AI_USE_POINTS = ['writes', 'margin', 'research', 'checked'] as const;

export function AiUseStatement() {
    const t = useTranslations('aiUse');
    return (
        <section aria-labelledby="ai-use-heading" data-testid="ai-use-statement">
            <Card className="space-y-default p-6">
                <h2 id="ai-use-heading" className="text-lg font-semibold text-content-emphasis">
                    {t('title')}
                </h2>
                <p className="text-sm font-medium text-content-emphasis" data-testid="ai-use-d3">
                    {t('statement')}
                </p>
                <ul className="list-disc space-y-tight pl-5 text-sm text-content-default">
                    {AI_USE_POINTS.map((k) => (
                        <li key={k}>{t(`points.${k}`)}</li>
                    ))}
                </ul>
                <p className="text-sm text-content-muted">{t('models')}</p>
            </Card>
        </section>
    );
}
