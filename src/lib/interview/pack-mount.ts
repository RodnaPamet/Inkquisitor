/**
 * THE MOUNT GATE — a pack is mounted only with a passing evaluation record
 * (Phase 2.3; roadmap 2.3: "A pack mounts only with a passing evaluation
 * record").
 *
 * Lifted from inflect-compliance's skill mount gate
 * (`src/lib/agentic/flue/skills/mount-gate.ts`; see docs/carve-manifest.md).
 * Per pack it decides whether a session may mount it, and refuses with a
 * named reason when it may not:
 *
 *   TEXT_REFUSED               the load-time text scan refused the pack
 *                              (`pack-text-scan.ts`); never mountable
 *   NO_RECORD                  no `evaluation-record.json` beside the pack
 *   RECORD_UNREADABLE          the record is not JSON
 *   (record refusals)          MALFORMED, PACK_MISMATCH, HASH_MISMATCH (the
 *                              pack changed since the record), SET_MISMATCH,
 *                              PROMPT_VERSION_MISMATCH, UNKNOWN_ANSWER,
 *                              DUPLICATE_ANSWER, UNANSWERED_CASE,
 *                              BELOW_THRESHOLD — all recomputed by replaying
 *                              the record (`pack-evaluation.ts`); then the
 *                              record's generator claim: GENERATOR_MISMATCH (a
 *                              "structural" record the structural generator
 *                              does not reproduce), STRUCTURAL_OUTPUT_AS_MODEL
 *                              (a "model" record holding its outputs)
 *   STRUCTURAL_RECORD_REFUSED  the record passes, but was made by the
 *                              structural generator and this deployment asks
 *                              for a model's record
 *
 * ── WHICH RECORDS COUNT (owner decision D11, 2026-11-19) ────────────────────
 *
 * A real-model record needs a provider key; they are made by the `Evals`
 * workflow (`.github/workflows/evals.yml`) and committed after review. A
 * STRUCTURAL record (`evals/structural-generator.ts`) proves the set runs end
 * to end through the product's round engine and every code-graded
 * expectation holds; it proves nothing about how a model words questions
 * under the pack. So (`pack-records-config.ts`):
 *
 *   production   only a model's record mounts a pack. With none committed,
 *                every pack is refused STRUCTURAL_RECORD_REFUSED (or worse),
 *                interviews answer 503 PACKS_NOT_MOUNTABLE naming each pack
 *                and its reason, and the server says so at every start. No
 *                setting overrides it. Never silent, never faked.
 *   otherwise    a structural record mounts a pack too (development, test).
 *
 * A pack with no record, or a record that does not pass, is refused in EVERY
 * environment: nothing is ever mounted unevaluated.
 *
 * ── PINS ────────────────────────────────────────────────────────────────────
 *
 * A session pins every pack it mounts when it starts (`InterviewSession.packPins`,
 * written once — a trigger refuses any change): the pack's name, version,
 * CONTENT HASH (over PACK.md exactly as the prompt carries it), the hash of
 * the record it mounted with and that record's kind. Before every later
 * round the pins are compared with the packs this process would send
 * (`pinMismatch`): a pack whose file changed since the session started is
 * refused (PACK_CHANGED), so a session is never taught by text other than
 * what it started with.
 *
 * A session from before pinning (2.2: NULL pins) is NOT pinned on first use
 * (decided in the 2.3 review): its earlier rounds were taught by packs nobody
 * recorded, so a pin written now would claim to know what it started with —
 * the reconstruction the write-once trigger exists to rule out, and the trigger
 * refuses NULL → value as it refuses every other change. Such a session pauses
 * PACK_CHANGED (`problem: PACK_NOT_PINNED`) on every round asked of it; its
 * history stays readable and the author starts a new session.
 */
import { craftPackName, personaPackName, type PackFile, type PackRegistry } from './packs';
import { checkPackRecord, type RecordKind, type RecordRefusal } from './pack-evaluation';
import type { BibleKind } from '@/lib/bible/kinds';
import { createHash } from 'node:crypto';
import { processSharedMap } from '@/lib/process-shared-cache';
import { ServiceUnavailableError } from '@/lib/errors/types';
import type { PersonaKey } from './vocabulary';
import type { PackRecordMode } from './pack-records-config';

export { PACK_RECORD_MODES, packRecordModeOf, type PackEnvRecord, type PackRecordMode } from './pack-records-config';

export type MountRefusal = 'TEXT_REFUSED' | 'NO_RECORD' | 'RECORD_UNREADABLE' | 'STRUCTURAL_RECORD_REFUSED' | RecordRefusal;

/** What a session records about each pack it mounted: enough to say what it was taught. */
export interface PackPin {
    readonly name: string;
    readonly version: number;
    /** `sha256:` over PACK.md exactly as the prompt carries it. */
    readonly contentHash: string;
    /** `sha256:` over the evaluation record the pack mounted with. */
    readonly recordHash: string;
    readonly recordKind: RecordKind;
}

export type MountVerdict = { ok: true; pin: PackPin } | { ok: false; reason: MountRefusal; detail: string };

/** May a session mount this pack under `mode`? */
export async function checkPackMountable(file: PackFile, registry: PackRegistry, mode: PackRecordMode): Promise<MountVerdict> {
    if (file.scan.rules.length > 0) return { ok: false, reason: 'TEXT_REFUSED', detail: `${file.scan.files.join(', ')}: ${[...file.scan.rules, ...file.scan.guardRules].join(', ')}` };
    if (file.record.state === 'absent') return { ok: false, reason: 'NO_RECORD', detail: 'no evaluation-record.json; run npm run packs:evaluate' };
    if (file.record.state === 'unreadable') return { ok: false, reason: 'RECORD_UNREADABLE', detail: file.record.error };
    const check = await checkPackRecord(file.record.raw, file, registry);
    if (!check.ok) return check;
    if (mode === 'model' && check.record.generator.kind !== 'model') {
        return { ok: false, reason: 'STRUCTURAL_RECORD_REFUSED', detail: 'production mounts a pack only on a real model’s evaluation record (D11)' };
    }
    return {
        ok: true,
        pin: { name: file.name, version: file.version, contentHash: file.contentHash, recordHash: file.record.hash, recordKind: check.record.generator.kind },
    };
}

/**
 * The verdicts, shared by every module graph of the process (issue #36, item
 * 7): the start-up warm-up (the instrumentation bundle) fills the map the
 * routes read, so the first `GET interview-packs` replays nothing. Keyed by
 * CONTENT — the mode, the pack, and the hashes of its text, its set and its
 * record — never by the registry object, which each graph loads for itself.
 */
const cache = processSharedMap<Promise<MountVerdict>>('pack-mount-verdicts');

const registryKeys = new WeakMap<PackRegistry, string>();
/** Every pack's content and set hash: a persona's replay runs beside the craft packs, which its own record does not pin. */
function registryKeyOf(registry: PackRegistry): string {
    let key = registryKeys.get(registry);
    if (!key) {
        const parts = Object.values(registry.files).map((f) => `${f.name}:${f.contentHash}:${f.setHash}`).sort();
        key = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
        registryKeys.set(registry, key);
    }
    return key;
}

/** The record as the verdict reads it: the hash of what was parsed (not of the file name or object), or its state. */
function recordKeyOf(file: PackFile): string {
    if (file.record.state !== 'present') return file.record.state;
    return createHash('sha256').update(JSON.stringify(file.record.raw) ?? 'undefined', 'utf8').digest('hex');
}

/** One pack's verdict under `mode`, computed once per process, mode and pack content. A replay that throws is a refusal, never a pass. */
function verdictOf(registry: PackRegistry, name: string, mode: PackRecordMode): Promise<MountVerdict> {
    const file = registry.files[name];
    const key = file ? `${mode}\u0000${registryKeyOf(registry)}\u0000${name}\u0000${file.contentHash}\u0000${file.setHash}\u0000${recordKeyOf(file)}\u0000${file.scan.rules.length === 0 ? 'scan-ok' : 'scan-refused'}` : `${mode}\u0000${name}\u0000missing`;
    let verdict = cache.get(key);
    if (!verdict) {
        verdict = !file
            ? Promise.resolve<MountVerdict>({ ok: false, reason: 'NO_RECORD', detail: 'no such pack' })
            : checkPackMountable(file, registry, mode).catch((err: unknown): MountVerdict => ({ ok: false, reason: 'MALFORMED', detail: err instanceof Error ? err.name : 'replay failed' }));
        cache.set(key, verdict);
    }
    return verdict;
}

/**
 * The verdicts under `mode` of the named packs (every pack when `names` is
 * omitted), each computed once per registry, mode and pack: the files are part
 * of the deployed build, like the packs, so re-checking per request buys
 * nothing, and a request asks only about the packs it would mount. A name the
 * registry does not hold is left out (`pinsFor` names it UNKNOWN_PACK).
 */
export async function packMounts(registry: PackRegistry, mode: PackRecordMode, names?: readonly string[]): Promise<ReadonlyMap<string, MountVerdict>> {
    const wanted = (names ?? Object.keys(registry.files)).filter((n) => n in registry.files);
    const out = new Map<string, MountVerdict>();
    for (const name of wanted) out.set(name, await verdictOf(registry, name, mode));
    return out;
}

/**
 * The packs a session over these kinds with these personas mounts, by name:
 * the craft pack of each kind in scope (in kind order, as given) and each
 * persona's pack (in the session's order).
 */
export function packNamesFor(kinds: readonly BibleKind[], personas: readonly PersonaKey[]): string[] {
    return [...kinds.map(craftPackName), ...personas.map(personaPackName)];
}

export interface PackRefusal {
    name: string;
    reason: MountRefusal | 'UNKNOWN_PACK';
}

/**
 * A request refused before anything is written: a pack the session would mount
 * does not mount here (no passing record, a refused text, a structural record
 * where the deployment asks for a model's). 503 `PACKS_NOT_MOUNTABLE`, naming
 * each pack and its reason; never a session started on unevaluated text.
 */
export class PacksNotMountableError extends ServiceUnavailableError {
    constructor(packs: readonly PackRefusal[]) {
        super('Interviews are not available right now: a question pack cannot be mounted.', { reason: 'PACKS_NOT_MOUNTABLE', packs });
        this.name = 'PacksNotMountableError';
    }
}

/** The pins for these packs, or every refusal among them (named; the detail stays in the log). */
export function pinsFor(names: readonly string[], mounts: ReadonlyMap<string, MountVerdict>): { ok: true; pins: PackPin[] } | { ok: false; refusals: PackRefusal[] } {
    const pins: PackPin[] = [];
    const refusals: PackRefusal[] = [];
    for (const name of names) {
        const v = mounts.get(name);
        if (!v) refusals.push({ name, reason: 'UNKNOWN_PACK' });
        else if (!v.ok) refusals.push({ name, reason: v.reason });
        else pins.push(v.pin);
    }
    return refusals.length > 0 ? { ok: false, refusals } : { ok: true, pins };
}

/** A pin as the session row stores it: the five keys, never an extra one a caller's object carried. */
export function pinForRow(p: PackPin): PackPin {
    return { name: p.name, version: p.version, contentHash: p.contentHash, recordHash: p.recordHash, recordKind: p.recordKind };
}

/**
 * `InterviewSession.packPins`, read back. Null when the row predates pinning
 * (a 2.2 session), or when the stored value is not a list of pins: a malformed
 * pin is never read as a record of what a session was taught.
 */
export function parsePackPins(value: unknown): PackPin[] | null {
    if (!Array.isArray(value)) return null;
    const pins: PackPin[] = [];
    for (const v of value) {
        if (!v || typeof v !== 'object') return null;
        const { name, version, contentHash, recordHash, recordKind } = v as Record<string, unknown>;
        if (typeof name !== 'string' || typeof version !== 'number' || typeof contentHash !== 'string' || typeof recordHash !== 'string') return null;
        if (recordKind !== 'structural' && recordKind !== 'model') return null;
        pins.push({ name, version, contentHash, recordHash, recordKind });
    }
    return pins;
}

export type PinProblem =
    /** A pinned pack's file is not the one the session started with. */
    | { reason: 'PACK_CHANGED'; packs: string[] }
    /** A pinned pack, unchanged, no longer mounts here (the record mode changed, or its record went). */
    | { reason: 'PACK_NOT_MOUNTABLE'; packs: PackRefusal[] }
    /** The session needs a pack it never pinned (a 2.2 session; a kind outside its pins). */
    | { reason: 'PACK_NOT_PINNED'; packs: string[] };

/**
 * Compare a session's pins with the packs this process would teach it, before
 * a round uses them. `needed` are the packs the round mounts (its kinds' craft
 * packs and its personas'). Null when every one is pinned, unchanged and still
 * mountable.
 */
export function pinMismatch(pins: readonly PackPin[] | null, needed: readonly string[], registry: PackRegistry, mounts: ReadonlyMap<string, MountVerdict>): PinProblem | null {
    const byName = new Map((pins ?? []).map((p) => [p.name, p] as const));
    const unpinned = needed.filter((n) => !byName.has(n));
    if (unpinned.length > 0) return { reason: 'PACK_NOT_PINNED', packs: unpinned };
    const changed = needed.filter((n) => registry.files[n]?.contentHash !== byName.get(n)!.contentHash);
    if (changed.length > 0) return { reason: 'PACK_CHANGED', packs: changed };
    const refused = pinsFor(needed, mounts);
    if (!refused.ok) return { reason: 'PACK_NOT_MOUNTABLE', packs: refused.refusals };
    return null;
}
