/**
 * The interview packs and whether each mounts (Phase 2.3): what 2.4's setup
 * sheet offers — the six personas (the manner dial) and the craft pack of each
 * element kind — with the mount gate's verdict on each.
 *
 * `bible.view`: what a session would be taught is product text, the same for
 * every workspace, and a reader of an interview may read how it was asked.
 * The pack TEXT is not returned (descriptions and coverage only): a refused
 * pack's text is what is under suspicion, and no surface delivers it.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { env } from '@/env';
import { getTemplate } from '@/lib/bible/templates';
import type { BibleKind } from '@/lib/bible/kinds';
import { getPacks, type PackGroup, type PackRegistry } from '@/lib/interview/packs';
import { packMounts, packRecordModeOf, type MountRefusal, type MountVerdict, type PackRecordMode } from '@/lib/interview/pack-mount';
import type { RecordKind } from '@/lib/interview/pack-evaluation';
import { isPersonaKey } from '@/lib/interview/vocabulary';

/** Which records mount a pack in this deployment (D11: a real model's in production, a structural one too elsewhere and on D13's loopback stub). */
export function deploymentPackRecordMode(): PackRecordMode {
    return packRecordModeOf({
        NODE_ENV: env.NODE_ENV,
        AI_MODEL_STUB: env.AI_MODEL_STUB,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        APP_URL: env.APP_URL,
        NEXTAUTH_URL: env.NEXTAUTH_URL,
    });
}

/** The named packs' verdicts in this deployment (or under `mode`, a test's); every pack's when `names` is omitted. Each computed once. */
export function deploymentPackMounts(packs: PackRegistry, mode: PackRecordMode = deploymentPackRecordMode(), names?: readonly string[]): Promise<ReadonlyMap<string, MountVerdict>> {
    return packMounts(packs, mode, names);
}

export interface PackView {
    name: string;
    group: PackGroup;
    /** The persona key, or the element kind. */
    key: string;
    /** The persona's display name, or the kind's label. */
    displayName: string;
    version: number;
    description: string;
    contentHash: string;
    /** A craft pack's declared field coverage (template keys); null for a persona. */
    coverage: string[] | null;
    /** Cases in the pack's evaluation set. */
    evaluationCases: number;
    mountable: boolean;
    /** Why it does not mount, named. */
    refusal: { reason: MountRefusal; detail: string } | null;
    /** The kind of record it mounts with (null when it does not mount). */
    recordKind: RecordKind | null;
}

export interface PacksView {
    /** Which records mount a pack here. */
    recordMode: PackRecordMode;
    personas: PackView[];
    craft: PackView[];
    /** Phase 3.3 (D24): the one relations pack, the craft guidance for every relation's fields. */
    relations: PackView[];
    /** How many of all the packs mount; zero of zero is never "all" (rule 6). */
    mountable: number;
    total: number;
}

function view(packs: PackRegistry, name: string, verdict: MountVerdict | undefined): PackView {
    const file = packs.files[name];
    const persona = file.group === 'persona' && isPersonaKey(file.key) ? packs.personas[file.key] : null;
    // Phase 3.3: the relations pack is craft guidance for every relation's fields.
    const craft = file.group === 'craft' ? packs.craft[file.key as BibleKind] : file.group === 'relations' ? packs.relations : file.group === 'scene' ? packs.scene : null;
    return {
        name,
        group: file.group,
        key: file.key,
        displayName: persona ? persona.displayName : file.group === 'relations' ? 'Relations' : file.group === 'scene' ? 'Scene card' : getTemplate(file.key as BibleKind).label,
        version: file.version,
        description: (persona ?? craft)!.description,
        contentHash: file.contentHash,
        coverage: craft ? [...craft.coverage] : null,
        evaluationCases: persona ? packs.personaEvals[persona.persona].length : file.group === 'relations' ? packs.relationEvals.length : file.group === 'scene' ? packs.sceneEvals.length : packs.craftEvals[file.key as BibleKind].length,
        mountable: verdict?.ok === true,
        refusal: !verdict ? { reason: 'NO_RECORD', detail: 'not checked' } : verdict.ok ? null : { reason: verdict.reason, detail: verdict.detail },
        recordKind: verdict?.ok ? verdict.pin.recordKind : null,
    };
}

export async function listInterviewPacks(ctx: WorkspaceRequestContext, packs: PackRegistry = getPacks(), mode: PackRecordMode = deploymentPackRecordMode()): Promise<PacksView> {
    await assertPermission(ctx, 'bible.view');
    const mounts = await deploymentPackMounts(packs, mode);
    const all = Object.keys(packs.files).map((name) => view(packs, name, mounts.get(name)));
    return {
        recordMode: mode,
        personas: all.filter((p) => p.group === 'persona'),
        craft: all.filter((p) => p.group === 'craft'),
        relations: all.filter((p) => p.group === 'relations' || p.group === 'scene'),
        mountable: all.filter((p) => p.mountable).length,
        total: all.length,
    };
}
