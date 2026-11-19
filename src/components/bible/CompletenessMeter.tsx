'use client';

/**
 * A completeness figure as a bar and words (Phase 1.2). Only a MEASURED
 * completeness draws a bar; "not started" and "not assessed" are words with
 * no bar at all, so nothing on screen can be read as 0% or 100% of nothing
 * (roadmap rule 6; `src/lib/bible/completeness.ts`).
 *
 * The bar is a native `<progress>`, which carries its role and value for
 * assistive technology, painted through the tokens.
 */
import { useTranslations } from 'next-intl';
import { completenessPercent, type Completeness } from '@/lib/bible/completeness';

export function CompletenessMeter({ value, label }: { value: Completeness; label: string }) {
    const t = useTranslations('bible.completeness');
    if (value.state !== 'measured') {
        return (
            <p className="text-xs font-medium text-content-subtle" data-completeness={value.state}>
                {value.state === 'not-started' ? t('notStarted') : t('notAssessed')}
            </p>
        );
    }
    const percent = completenessPercent(value);
    return (
        <div className="space-y-tight" data-completeness="measured">
            <progress
                className="block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-bg-subtle [&::-moz-progress-bar]:bg-[var(--brand-default)] [&::-webkit-progress-bar]:bg-bg-subtle [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-[var(--brand-default)]"
                value={value.filled}
                max={value.total}
                aria-label={label}
            />
            <p className="text-xs text-content-muted">{t('measured', { percent, filled: value.filled, total: value.total })}</p>
        </div>
    );
}
