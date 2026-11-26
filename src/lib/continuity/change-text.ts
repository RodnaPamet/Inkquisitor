/**
 * WHAT CHANGED, for "Grill me on what changed" (Phase 4.2, D28). Pure. The
 * upstream element's entry before the change a stale flag stands for and as it
 * stands now, rendered as 4.1 renders an entry (`entry-text.ts`), reduced to the
 * sections that differ (one that is gone reads "(removed)"), bounded. It is
 * author text: it reaches the question generator only as a fenced data block.
 */
import type { RenderedEntry } from '@/lib/facts/entry-text';
import { truncateGraphemes } from '@/lib/text/truncate';
import { STALE_CHANGE_MAX_CHARS } from './vocabulary';

export function upstreamChangeText(before: RenderedEntry | null, after: RenderedEntry): string {
    const was = new Map((before?.body ?? []).map((s) => [s.key, s] as const));
    const now = new Map(after.body.map((s) => [s.key, s] as const));
    const lines: string[] = [...after.header.map((s) => `${s.label}: ${s.text}`)];
    for (const s of after.body) {
        const old = was.get(s.key);
        if (old && old.text === s.text) continue;
        lines.push(old ? `${s.label}: was "${old.text}"; now "${s.text}"` : `${s.label}: now "${s.text}"`);
    }
    for (const s of before?.body ?? []) if (!now.has(s.key)) lines.push(`${s.label}: was "${s.text}"; now (removed)`);
    const text = lines.join('\n');
    return truncateGraphemes(text, STALE_CHANGE_MAX_CHARS);
}
