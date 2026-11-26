/**
 * The browser's side of book-level interrogation (Phase 4.3, D29): the URL
 * table over the bible's `bibleFetch` (a refusal throws `BibleApiError` with
 * its `details.reason`, worded by the page through next-intl). Types only from
 * the usecases. Client-safe.
 */
import { bibleFetch } from '@/lib/bible/api-client';
import type { StressTestPage, StressTestView, WeakPointView } from '@/app-layer/usecases/stress-tests';
import type { GapHuntPage, GapHuntView } from '@/app-layer/usecases/gap-hunts';

export type { GapHuntPage, GapHuntView, StressTestPage, StressTestView, WeakPointView };

const enc = encodeURIComponent;
const book = (slug: string, bookId: string) => `/api/w/${enc(slug)}/books/${enc(bookId)}`;

export const INTERROGATION_API = {
    stressTests: (slug: string, bookId: string) => `${book(slug, bookId)}/stress-tests`,
    stressTest: (slug: string, bookId: string, id: string) => `${book(slug, bookId)}/stress-tests/${enc(id)}`,
    gapHunts: (slug: string, bookId: string) => `${book(slug, bookId)}/gap-hunts`,
} as const;

export const interrogationApi = {
    stressPage: (slug: string, bookId: string) => bibleFetch<StressTestPage>(INTERROGATION_API.stressTests(slug, bookId)),
    startStressTest: (slug: string, bookId: string, confirmWorstCaseMicroUsd: number) =>
        bibleFetch<{ stressTest: StressTestView }>(INTERROGATION_API.stressTests(slug, bookId), { method: 'POST', body: { confirmWorstCaseMicroUsd } }),
    stressTest: (slug: string, bookId: string, id: string) => bibleFetch<{ stressTest: StressTestView }>(INTERROGATION_API.stressTest(slug, bookId, id)),
    gapPage: (slug: string, bookId: string) => bibleFetch<GapHuntPage>(INTERROGATION_API.gapHunts(slug, bookId)),
    runGapHunt: (slug: string, bookId: string, confirmWorstCaseMicroUsd: number | null) =>
        bibleFetch<{ hunt: GapHuntView }>(INTERROGATION_API.gapHunts(slug, bookId), { method: 'POST', body: confirmWorstCaseMicroUsd === null ? {} : { confirmWorstCaseMicroUsd } }),
};

/** A cost as the page shows it (4.0's rule: under a cent reads "< $0.01"). */
export function formatCost(micro: number): string {
    if (micro > 0 && micro < 10_000) return '< $0.01';
    return `$${(micro / 1_000_000).toFixed(2)}`;
}
