import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { env } from '@/env';
import { KitchenSink } from '@/components/dev/KitchenSink';

export const metadata: Metadata = { title: 'Kitchen sink — Inkquisitor', robots: { index: false } };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * `/dev/kitchen-sink` — every lifted UI primitive on one page.
 *
 * A development surface: in a production build (`NODE_ENV=production`) the
 * route answers 404 and the sink is never rendered.
 *
 * The search params are handed to the sink as `initialFilters` so its filter
 * toolbar renders the same state on the server as on the client's first
 * render: the toolbar writes its state to the URL, and without this a reload
 * of `/dev/kitchen-sink?stage=Drafting` would draw a pill only on the client
 * (a hydration mismatch). Multi-values arrive as arrays and are comma-joined,
 * the toolbar's URL separator.
 *
 * `tests/unit/kitchen-sink-route.test.tsx` holds the gate and the hand-off.
 */
export default async function KitchenSinkPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    if (env.NODE_ENV === 'production') notFound();
    const params = await searchParams;
    const initialFilters: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        const flat = Array.isArray(value) ? value.join(',') : value;
        if (flat) initialFilters[key] = flat;
    }
    return <KitchenSink initialFilters={initialFilters} />;
}
