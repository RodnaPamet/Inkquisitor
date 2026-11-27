/**
 * REFUSED SECTIONS ARE RETRIED ON A SAFETY UPDATE (Phase 4.H-b, decision D32). Pure.
 *
 * 4.H-a moved an entry's baseline past a section the guard refused (a refused
 * piece yields nothing, and the version still becomes the baseline), so the
 * refused text is sent again only once the author changes it. D32 adds: when
 * the guard's rules change (`GUARD_RULES_VERSION`), what they refused may now
 * pass, so a refused section is sent again ONCE under the newer rules.
 *
 * Each extraction that becomes a baseline records the sections refused so far
 * and the rule version that refused each (`BibleFactExtraction.guardRefused`).
 * The next extraction of the entry reads its baseline's record:
 *
 *   • a section no longer in the entry is dropped (it states nothing);
 *   • a section that CHANGED is sent anyway (it is in the changed sections) and
 *     recorded again only if refused again;
 *   • a section unchanged and refused under an OLDER version is sent again now
 *     (`retried`), beside the changed sections, and recorded again — under the
 *     current version — only if the new rules refuse it too;
 *   • a section unchanged and refused under the current version is carried
 *     forward as it is (sent never: the same rules refuse the same text).
 *
 * So each rules change re-sends a refused section at most once, and the record
 * never grows past the entry's sections.
 */
import type { EntrySection } from './entry-text';
import { GUARD_REFUSED_SECTIONS_MAX, type GuardRefusedSection } from './vocabulary';

export interface GuardRetryPlan {
    /** What the version sends: its changed sections and the refused ones retried, in the entry's order. */
    readonly send: EntrySection[];
    /** The keys retried under the newer rules. */
    readonly retried: string[];
    /** Refusals carried forward unchanged (same rules, same text). */
    readonly carried: GuardRefusedSection[];
}

export function guardRetryPlan(input: { body: readonly EntrySection[]; changed: readonly EntrySection[]; baselineRefused: readonly GuardRefusedSection[]; rulesVersion: number }): GuardRetryPlan {
    const inEntry = new Set(input.body.map((s) => s.key));
    const changed = new Set(input.changed.map((s) => s.key));
    const retried = new Set<string>();
    const carried: GuardRefusedSection[] = [];
    for (const r of input.baselineRefused) {
        if (!inEntry.has(r.key) || changed.has(r.key)) continue;
        if (r.rulesVersion < input.rulesVersion) retried.add(r.key);
        else carried.push(r);
    }
    const send = input.body.filter((s) => changed.has(s.key) || retried.has(s.key));
    return { send, retried: [...retried], carried };
}

/** What the version records as refused: the carried refusals and every section of a refused call, under the current rules. */
export function refusalsToRecord(carried: readonly GuardRefusedSection[], refusedKeys: Iterable<string>, rulesVersion: number): GuardRefusedSection[] | null {
    const out = new Map<string, GuardRefusedSection>();
    for (const r of carried) out.set(r.key, r);
    for (const key of refusedKeys) out.set(key, { key, rulesVersion });
    const list = [...out.values()].slice(0, GUARD_REFUSED_SECTIONS_MAX);
    return list.length === 0 ? null : list;
}
