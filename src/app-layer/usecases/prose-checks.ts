/**
 * The prose checks' reads and the author's acts on them (Phase 5.2, D34).
 *
 *   getSceneProseChecks      a scene's check for the editor's margin: its status
 *                            (rule 6: NOT_CHECKED is never "no notes"), its
 *                            readability, its findings — each with the text it
 *                            covered, read from the scene's current text, so
 *                            the editor places a note only where its own text
 *                            still reads the same — rules turned off and
 *                            dismissed sentences left out and counted
 *   requestSceneProseCheck   "check now": queue the scene's check (an editor
 *                            opening a scene never checked, or out of date)
 *   rerunChapterProseChecks  the author re-runs a chapter: every scene queued
 *   dismissProseFinding      one note dismissed: its rule and its sentence's
 *                            keyed hash, so it stays dismissed while the
 *                            sentence is unchanged and comes back when it changes
 *   clearProseDismissals     every dismissal of the book removed
 *   getProseCheckSettings / saveProseCheckSettings   rules off for the book, the
 *                            inclusive-language switch (off by default), the
 *                            style sheet in use, character names that look alike
 *
 * `bible.view` reads, `bible.edit` acts. The PRODUCT NEVER APPLIES AN EDIT: a
 * suggestion is applied by the author, in the editor, through its autosave
 * (D34 item 4); nothing here writes a scene, and nothing here reaches a model.
 * Settings and dismissals are audited with ids and codes only.
 */
import type { WorkspaceRequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { assertPermission } from '@/app-layer/policies/permission.policy';
import { ManuscriptSceneRepository } from '@/app-layer/repositories/manuscript.repository';
import { ProseCheckRepository } from '@/app-layer/repositories/prose-check.repository';
import { ManuscriptIdParam } from '@/app-layer/schemas/manuscript';
import { DismissProseFindingInput, ProseCheckSettingsInput } from '@/app-layer/schemas/prose-checks';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { proseConfigKey, proseTextKey } from '@/lib/prose-checks/keys';
import { sceneProseText } from '@/lib/prose-checks/scene-text';
import { similarNamePairs } from '@/lib/prose-checks/similar-names';
import { parseFindingDetail } from '@/lib/prose-checks/storage';
import {
    PROSE_CHAPTER_RERUN_MAX,
    PROSE_DISMISSALS_PER_BOOK_MAX,
    PROSE_FINDINGS_PER_SCENE_MAX,
    PROSE_RULES,
    PROSE_RULES_VERSION,
    isProseRuleId,
    readabilityBand,
    type ProseCheckSettingsView,
    type ProseCheckStatus,
    type ProseFindingView,
    type ProseRuleId,
    type SceneProseChecksView,
} from '@/lib/prose-checks/vocabulary';
import { requireBook } from './bible-common';
import { requireChapter, requireScene } from './manuscript-common';
import { readBookCheckSetup } from './prose-check-setup';
import { scheduleProseCheck, type EnqueueProseCheck, type ProseCheckScheduled } from './prose-check-schedule';

/** Similar-name pairs the settings list at most. */
const SIMILAR_PAIRS_SHOWN = 50;

function statusOf(check: { textKey: string; rulesVersion: number; configKey: string } | null, currentTextKey: string, currentConfigKey: string): ProseCheckStatus {
    if (!check) return 'NOT_CHECKED';
    if (check.textKey !== currentTextKey) return 'PENDING';
    if (check.rulesVersion !== PROSE_RULES_VERSION || check.configKey !== currentConfigKey) return 'OUTDATED';
    return 'CHECKED';
}

/** A scene's prose check, as the editor's margin reads it (`bible.view`). */
export async function getSceneProseChecks(ctx: WorkspaceRequestContext, bookId: string, sceneId: string): Promise<SceneProseChecksView> {
    await assertPermission(ctx, 'bible.view');
    const id = ManuscriptIdParam.parse(sceneId);
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const scene = await ManuscriptSceneRepository.find(db, ctx.workspaceId, bookId, id);
        if (!scene) throw new NotFoundError('Scene not found.');
        const setup = await readBookCheckSetup(db, ctx.workspaceId, bookId);
        const check = await ProseCheckRepository.findCheck(db, ctx.workspaceId, bookId, id);
        const status = statusOf(check, proseTextKey(ctx.workspaceId, scene.text), proseConfigKey(ctx.workspaceId, setup.sheet, setup.alexEnabled));
        const base: SceneProseChecksView = {
            sceneId: id,
            status,
            checkedRevision: check?.revision ?? null,
            textCut: check?.textCut ?? false,
            findingsCut: check?.findingsCut ?? false,
            wordsChecked: check?.wordsChecked ?? 0,
            readability:
                check && check.readingEase !== null && check.gradeLevel !== null
                    ? { words: check.wordsChecked, sentences: check.sentences, readingEase: check.readingEase, gradeLevel: check.gradeLevel, band: readabilityBand(check.readingEase) }
                    : null,
            styleSheetElementId: setup.sheet.elementId,
            rulesNotRun: (check?.rulesNotRun ?? []).filter(isProseRuleId),
            findings: [],
            dismissed: 0,
            hiddenByRule: 0,
        };
        // A check of another text has no valid offsets: nothing to place.
        if (!check || status === 'PENDING') return base;
        const settings = await ProseCheckRepository.findSettings(db, ctx.workspaceId, bookId);
        const off = new Set<string>(settings?.rulesOff ?? []);
        const rows = await ProseCheckRepository.listFindings(db, ctx.workspaceId, check.id, PROSE_FINDINGS_PER_SCENE_MAX);
        const dismissed = await ProseCheckRepository.dismissedKeys(db, ctx.workspaceId, bookId, rows.map((r) => r.sentenceKey));
        const text = sceneProseText(scene.text).text;
        const findings: ProseFindingView[] = [];
        let hiddenByRule = 0;
        let dismissedCount = 0;
        for (const r of rows) {
            if (!isProseRuleId(r.ruleId)) continue;
            const alexOff = r.ruleId === 'inclusive-language' && !setup.alexEnabled;
            if (off.has(r.ruleId) || alexOff) {
                hiddenByRule++;
                continue;
            }
            if (dismissed.has(`${r.ruleId}\u0000${r.sentenceKey}`)) {
                dismissedCount++;
                continue;
            }
            if (r.end > text.length) continue;
            const detail = parseFindingDetail(r.detail);
            const s = detail.suggestion;
            findings.push({
                id: r.id,
                ruleId: r.ruleId,
                severity: r.severity === 'WARNING' ? 'WARNING' : 'NOTE',
                start: r.start,
                end: r.end,
                matched: text.slice(r.start, r.end),
                params: detail.params,
                suggestion: s && PROSE_RULES[r.ruleId].suggests && s.end <= text.length ? { ...s, matched: text.slice(s.start, s.end) } : null,
            });
        }
        return { ...base, findings, dismissed: dismissedCount, hiddenByRule };
    });
}

/** Queue a scene's check now (`bible.edit`): the editor's "check now", for a scene never checked or out of date. */
export async function requestSceneProseCheck(ctx: WorkspaceRequestContext, bookId: string, sceneId: string, deps: { enqueue?: EnqueueProseCheck } = {}): Promise<{ scheduled: ProseCheckScheduled }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(sceneId);
    await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireScene(db, ctx, bookId, id);
    });
    return { scheduled: await scheduleProseCheck(ctx.workspaceId, id, { delayMs: 0, enqueue: deps.enqueue }) };
}

/** Re-run a chapter's checks (`bible.edit`): every scene queued (at most `PROSE_CHAPTER_RERUN_MAX`; the rest are counted). */
export async function rerunChapterProseChecks(
    ctx: WorkspaceRequestContext,
    bookId: string,
    chapterId: string,
    deps: { enqueue?: EnqueueProseCheck } = {},
): Promise<{ queued: number; notQueued: number; scheduled: ProseCheckScheduled }> {
    await assertPermission(ctx, 'bible.edit');
    const id = ManuscriptIdParam.parse(chapterId);
    const sceneIds = await runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        await requireChapter(db, ctx, bookId, id);
        return ProseCheckRepository.chapterSceneIds(db, ctx.workspaceId, bookId, id, PROSE_CHAPTER_RERUN_MAX + 1);
    });
    const take = sceneIds.slice(0, PROSE_CHAPTER_RERUN_MAX);
    let queued = 0;
    let scheduled: ProseCheckScheduled = 'SCHEDULED';
    for (const sceneId of take) {
        const r = await scheduleProseCheck(ctx.workspaceId, sceneId, { delayMs: 0, enqueue: deps.enqueue });
        if (r !== 'SCHEDULED') {
            scheduled = r;
            break;
        }
        queued++;
    }
    return { queued, notQueued: sceneIds.length - queued, scheduled };
}

/** Dismiss one note (`bible.edit`): its rule and its sentence's key, so it stays dismissed while the sentence reads the same. */
export async function dismissProseFinding(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<{ dismissed: true }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        // The book first: a deleted book answers 404 whatever the body says.
        await requireBook(db, ctx, bookId);
        const parsed = DismissProseFindingInput.parse(input);
        const finding = await ProseCheckRepository.findFinding(db, ctx.workspaceId, parsed.findingId);
        if (!finding || finding.check.bookId !== bookId) throw new NotFoundError('That note is gone.', { reason: 'FINDING_GONE' });
        await ProseCheckRepository.dismiss(db, ctx.workspaceId, bookId, finding.ruleId, finding.sentenceKey, PROSE_DISMISSALS_PER_BOOK_MAX);
        // AUDIT LAST: ids and the rule, never the sentence.
        await logEvent(ctx, { action: 'PROSE_FINDING_DISMISSED', entityType: 'ProseFinding', entityId: finding.id, details: { bookId, sceneId: finding.check.sceneId, ruleId: finding.ruleId } }, { db });
        return { dismissed: true as const };
    });
}

/** Remove every dismissal of the book (`bible.edit`): the notes come back at the next read. */
export async function clearProseDismissals(ctx: WorkspaceRequestContext, bookId: string): Promise<{ cleared: number }> {
    await assertPermission(ctx, 'bible.edit');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const cleared = await ProseCheckRepository.clearDismissals(db, ctx.workspaceId, bookId);
        await logEvent(ctx, { action: 'PROSE_DISMISSALS_CLEARED', entityType: 'Book', entityId: bookId, details: { bookId, cleared } }, { db });
        return { cleared };
    });
}

/** The book's prose-check settings (`bible.view`). */
export async function getProseCheckSettings(ctx: WorkspaceRequestContext, bookId: string): Promise<ProseCheckSettingsView> {
    await assertPermission(ctx, 'bible.view');
    return runInWorkspaceContext(ctx, async (db) => {
        await requireBook(db, ctx, bookId);
        const setup = await readBookCheckSetup(db, ctx.workspaceId, bookId);
        const settings = await ProseCheckRepository.findSettings(db, ctx.workspaceId, bookId);
        const pairs = similarNamePairs(setup.characters);
        return {
            alexEnabled: settings?.alexEnabled ?? false,
            rulesOff: (settings?.rulesOff ?? []).filter(isProseRuleId),
            dismissals: await ProseCheckRepository.countDismissals(db, ctx.workspaceId, bookId),
            styleSheet: setup.sheet.elementId && setup.styleName !== null ? { elementId: setup.sheet.elementId, name: setup.styleName } : null,
            similarNames: pairs.slice(0, SIMILAR_PAIRS_SHOWN).map((p) => ({ a: { id: p.a.id, name: p.a.name }, b: { id: p.b.id, name: p.b.name }, why: p.why })),
            similarNamesCut: pairs.length > SIMILAR_PAIRS_SHOWN,
        };
    });
}

/** Replace the book's settings (`bible.edit`): the inclusive-language switch and the rules off. Audited (codes only). */
export async function saveProseCheckSettings(ctx: WorkspaceRequestContext, bookId: string, input: unknown): Promise<ProseCheckSettingsView> {
    await assertPermission(ctx, 'bible.edit');
    await runInWorkspaceContext(ctx, async (db) => {
        // The book first: a deleted book answers 404 whatever the body says.
        await requireBook(db, ctx, bookId);
        const parsed = ProseCheckSettingsInput.safeParse(input);
        if (!parsed.success) throw new ValidationError('Those settings are not valid.', { reason: 'UNKNOWN_RULE' });
        const rulesOff = [...new Set(parsed.data.rulesOff)].sort() as ProseRuleId[];
        const before = await ProseCheckRepository.findSettings(db, ctx.workspaceId, bookId);
        const saved = await ProseCheckRepository.saveSettings(db, ctx.workspaceId, bookId, { alexEnabled: parsed.data.alexEnabled, rulesOff });
        const changed = (before?.alexEnabled ?? false) !== saved.alexEnabled || JSON.stringify(before?.rulesOff ?? []) !== JSON.stringify(saved.rulesOff);
        if (changed) {
            await logEvent(ctx, { action: 'PROSE_CHECK_SETTINGS_CHANGED', entityType: 'Book', entityId: bookId, details: { bookId, alexEnabled: saved.alexEnabled, rulesOff: saved.rulesOff } }, { db });
        }
    });
    return getProseCheckSettings(ctx, bookId);
}
