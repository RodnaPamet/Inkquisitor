/**
 * Fixtures for the fact layer (Phase 4.1, D27), made through the product's own
 * usecases: a character saved twice, each version extracted by a scripted
 * extractor — the second restating one fact (provenance) and changing an age
 * (a proposal) — so every fact-layer table holds a row. Nothing reaches a network.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { executeBibleFactExtraction } from '@/app-layer/usecases/bible-facts';
import { FactExtractionRepository } from '@/app-layer/repositories/fact-layer.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import type { FactExtractor } from '@/lib/sources/extractor';
import { setFakeApiKey } from './fake-anthropic';

/** A scripted extractor: from each entry, "<Name> is N years old" (AGE, contradicting every AGE shown) and "<Name> keeps the lock" (OTHER). */
export function ageExtractor(name: string): () => FactExtractor {
    return () => ({
        async extract(request) {
            const text = request.data.find((b) => b.label === 'entry.text')?.text ?? '';
            const shown = request.data.find((b) => b.label === 'existing-facts')?.text ?? '';
            const contradicts = shown
                .split('\n')
                .filter((l) => l.includes('[AGE]'))
                .map((l) => Number(/^(\d+)\./.exec(l)?.[1] ?? 0))
                .filter((n) => n > 0);
            const facts: unknown[] = [];
            const age = new RegExp(`${name} is (\\d+) years old`).exec(text);
            if (age) facts.push({ subject: name, predicate: 'AGE', object: `${age[1]} years old`, statement: `${name} is ${age[1]} years old.`, quote: age[0], storyTimeFrom: '', storyTimeTo: '', contradicts });
            if (text.includes(`${name} keeps the lock`)) facts.push({ subject: name, predicate: 'OTHER', object: '', statement: `${name} keeps the lock at Harrow Weir.`, quote: `${name} keeps the lock at Harrow Weir`, storyTimeFrom: '', storyTimeTo: '', contradicts: [] });
            return { ok: true, output: { facts }, tokensUsed: 1, costMicroUsd: 1, callIds: [] };
        },
    });
}

/** A due window every row falls in (tests mark rows by hand, whenever they were written or stopped). */
export const ANY_DUE = Object.freeze({ now: new Date('9999-01-01T00:00:00Z'), settledBefore: new Date('9999-01-01T00:00:00Z'), staleBefore: new Date('9999-01-01T00:00:00Z') });

/** Run every extraction row of the book still PENDING (the dispatcher's marking, then the job). */
export async function extractPending(ctx: WorkspaceRequestContext, bookId: string, extractor: () => FactExtractor): Promise<Array<string | null>> {
    const due = await runInWorkspaceContext(ctx, async (db) => {
        const rows = (await FactExtractionRepository.listForBook(db, ctx.workspaceId, bookId, 200)).filter((r) => r.status === 'PENDING').reverse();
        for (const r of rows) await FactExtractionRepository.markQueued(db, ctx.workspaceId, r.id, new Date(), ANY_DUE);
        return rows.map((r) => r.id);
    });
    const outcomes: Array<string | null> = [];
    // A configured deployment (a key nothing is sent with: the extractor is scripted).
    const undo = setFakeApiKey();
    try {
        for (const extractionId of due) {
            const r = await executeBibleFactExtraction({ workspaceId: ctx.workspaceId, extractionId }, { extractor, charge: () => undefined, gate: () => ({ mounted: true, recordKind: 'structural' }) });
            outcomes.push(r.outcome);
        }
    } finally {
        undo();
    }
    return outcomes;
}

export async function seedFactLayer(ctx: WorkspaceRequestContext, bookId: string, marker: string): Promise<{ elementId: string }> {
    const name = `Wren${marker.replace(/[^A-Za-z]/g, '')}`;
    const el = await createElement(ctx, bookId, { kind: 'CHARACTER', name, summary: `${name} is 12 years old. ${name} keeps the lock at Harrow Weir.` });
    await extractPending(ctx, bookId, ageExtractor(name));
    await updateElement(ctx, bookId, el.id, { summary: `${name} is 13 years old. ${name} keeps the lock at Harrow Weir.`, baseVersion: 1 });
    await extractPending(ctx, bookId, ageExtractor(name));
    return { elementId: el.id };
}
