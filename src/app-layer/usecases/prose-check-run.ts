/**
 * THE `prose-check` JOB'S WORK (Phase 5.2, decision D34): one scene, checked
 * by deterministic code (`src/lib/prose-checks/engine.ts`), its findings
 * stored for the editor's margin. NO MODEL is called and no text is written:
 * the product never applies an edit (D3; the guard
 * `tests/guards/scene-text-stays-off-the-model-path.test.ts` holds this
 * module's import graph off the model layer and off the text writer).
 *
 *   0. THE MINUTE: `chargeProseCheckRun`; past the workspace's bound the check
 *      is put back on the queue for when the minute frees (RATE_LIMITED)
 *   1. READ, in the workspace's context: the scene's CURRENT text (decrypted),
 *      the book's style sheet (compiled), its settings, its character names,
 *      its word baseline (recomputed when older than
 *      `PROSE_BASELINE_MAX_AGE_MS`, every scene's text read a bounded batch at
 *      a time and stored encrypted)
 *   2. CHECK, outside every transaction: the scene's plain text through the
 *      engine, bounded and counted
 *   3. STORE, in one transaction under the scene's advisory lock (the lock a
 *      save takes): only while the scene's text is still the text checked —
 *      a newer save supersedes it (SUPERSEDED: that save's own check is queued),
 *      so no stale finding is ever stored over a newer text — the scene's
 *      check and findings replaced whole
 *
 * A workspace whose data key will not unwrap (or any other throw) fails only
 * this job: logged with ids and a code, counted (`servedWorkspace`), never the
 * message. Nothing is logged but ids, counts and codes; no finding is audited.
 */
import { randomUUID } from 'node:crypto';
import { servedWorkspace } from '@/app-layer/jobs/workspace-isolation';
import { BookRepository } from '@/app-layer/repositories/book.repository';
import { ManuscriptRepository } from '@/app-layer/repositories/manuscript.repository';
import { ProseBaselineRepository, ProseCheckRepository, ProseFindingRepository, type NewFinding } from '@/app-layer/repositories/prose-check.repository';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';
import { buildBaseline, parseBaseline, serialiseBaseline } from '@/lib/prose-checks/baseline';
import { runProseChecks } from '@/lib/prose-checks/engine';
import { proseConfigKey, proseSentenceKey, proseTextKey } from '@/lib/prose-checks/keys';
import type { WordBaseline } from '@/lib/prose-checks/rules/types';
import { sceneProseText } from '@/lib/prose-checks/scene-text';
import { sanitiseFindingDetail } from '@/lib/prose-checks/storage';
import { PROSE_BASELINE_MAX_AGE_MS, PROSE_BASELINE_TEXT_MAX_CHARS, PROSE_RULES_VERSION, isProseRuleId, type ProseRuleId } from '@/lib/prose-checks/vocabulary';
import { HtmlTextReader } from '@/lib/search/plain-text';
import { chargeProseCheckRun } from '@/lib/security/prose-check-rate-limit';
import { SCENES_PER_MANUSCRIPT_MAX } from '@/lib/manuscript/vocabulary';
import { readBookCheckSetup } from './prose-check-setup';
import { defaultEnqueueProseCheck, scheduleProseCheck, type EnqueueProseCheck } from './prose-check-schedule';

export type ProseCheckOutcome = 'CHECKED' | 'SUPERSEDED' | 'SCENE_GONE' | 'RATE_LIMITED' | 'FAILED';

export interface ProseCheckDeps {
    /** The clock the baseline's age is judged by (tests). */
    now?: () => Date;
    /** The workspace's minute (tests); omitted: `chargeProseCheckRun`. */
    charge?: (workspaceId: string) => number;
    /** The queue a rate-limited check goes back on (tests); omitted: BullMQ. */
    requeue?: EnqueueProseCheck;
    /** Test seam: runs after the check, before its store (a save landing meanwhile). */
    beforeStore?: () => Promise<void>;
}

/** Scenes read a statement at a time by the baseline. */
const BASELINE_BATCH = 100;
/** A scene's stored HTML is about this many times its words in characters (the baseline's read is planned by it). */
const CHARS_PER_WORD_ESTIMATE = 8;

/** The book's word baseline: the stored one while fresh, else recomputed from every scene's text (bounded) and stored. */
async function bookBaseline(scope: { workspaceId: string; requestId: string }, bookId: string, now: Date): Promise<WordBaseline | null> {
    const workspaceId = scope.workspaceId;
    const stored = await runInWorkspaceContext(scope, (db) => ProseBaselineRepository.find(db, workspaceId, bookId));
    if (stored && now.getTime() - stored.computedAt.getTime() < PROSE_BASELINE_MAX_AGE_MS) {
        const parsed = parseBaseline(stored.baseline);
        if (parsed) return parsed;
    }
    // Plan the read by stored word counts, so no scene past the bound is decrypted.
    const sizes = await runInWorkspaceContext(scope, (db) => ProseCheckRepository.listSceneSizes(db, workspaceId, bookId, SCENES_PER_MANUSCRIPT_MAX + 1));
    const ids: string[] = [];
    let estimate = 0;
    for (const s of sizes) {
        estimate += s.wordCount * CHARS_PER_WORD_ESTIMATE;
        if (estimate > PROSE_BASELINE_TEXT_MAX_CHARS) break;
        ids.push(s.id);
    }
    const reader = new HtmlTextReader();
    const texts: string[] = [];
    for (let i = 0; i < ids.length; i += BASELINE_BATCH) {
        const batch = await runInWorkspaceContext(scope, (db) => ProseCheckRepository.sceneTexts(db, workspaceId, bookId, ids.slice(i, i + BASELINE_BATCH)));
        for (const s of batch) if (s.text !== '') texts.push(reader.read(s.text));
    }
    const built = buildBaseline(texts);
    const cut = built.cut || ids.length < sizes.length;
    await runInWorkspaceContext(scope, (db) =>
        ProseBaselineRepository.save(db, workspaceId, bookId, { baseline: serialiseBaseline(built), totalWords: built.totalWords, scenesRead: built.scenesRead, cut, computedAt: now }),
    );
    return built;
}

export async function executeProseCheck(payload: { workspaceId: string; sceneId: string }, deps: ProseCheckDeps = {}): Promise<{ outcome: ProseCheckOutcome; findings: number }> {
    const { workspaceId, sceneId } = payload;
    const now = (deps.now ?? (() => new Date()))();
    const wait = (deps.charge ?? chargeProseCheckRun)(workspaceId);
    if (wait > 0) {
        await scheduleProseCheck(workspaceId, sceneId, { delayMs: wait, enqueue: deps.requeue ?? defaultEnqueueProseCheck });
        logger.info('prose check deferred', { component: 'prose-checks', workspaceId, sceneId, waitMs: wait });
        return { outcome: 'RATE_LIMITED', findings: 0 };
    }
    const result = await servedWorkspace('prose-check', { workspaceId, sceneId }, async () => {
        const scope = { workspaceId, requestId: randomUUID() };
        // 1. READ.
        const read = await runInWorkspaceContext(scope, async (db) => {
            const scene = await ProseCheckRepository.sceneForCheck(db, workspaceId, sceneId);
            if (!scene || !(await BookRepository.find(db, workspaceId, scene.bookId))) return null;
            return { scene, setup: await readBookCheckSetup(db, workspaceId, scene.bookId) };
        });
        if (!read) return { outcome: 'SCENE_GONE' as const, findings: 0 };
        const { scene, setup } = read;
        const textKey = proseTextKey(workspaceId, scene.text);
        const baseline = scene.text === '' ? null : await bookBaseline(scope, scene.bookId, now);

        // 2. CHECK (no transaction held).
        const prose = sceneProseText(scene.text);
        const out = runProseChecks({
            text: prose.text,
            italics: prose.italics,
            sheet: setup.sheet,
            alexEnabled: setup.alexEnabled,
            characters: setup.characters,
            baseline,
            sentenceKey: (ruleId: ProseRuleId, sentence: string) => proseSentenceKey(workspaceId, ruleId, sentence),
        });
        const findings: NewFinding[] = out.findings.map((f) => ({
            ruleId: f.ruleId,
            severity: f.severity,
            start: f.start,
            end: f.end,
            sentenceKey: f.sentenceKey,
            detail: sanitiseFindingDetail({ params: f.params, suggestion: f.suggestion }),
        }));

        // 3. STORE, only over the text that was checked.
        await deps.beforeStore?.();
        const stored = await runInWorkspaceContext(
            scope,
            async (db) => {
                await ManuscriptRepository.lockScene(db, sceneId);
                const current = await ProseCheckRepository.sceneForCheck(db, workspaceId, sceneId);
                if (!current) return 'SCENE_GONE' as const;
                if (current.revision !== scene.revision && proseTextKey(workspaceId, current.text) !== textKey) return 'SUPERSEDED' as const;
                const existing = await ProseCheckRepository.findCheck(db, workspaceId, scene.bookId, sceneId);
                // A worker on newer rules already stored a check of this text: an older worker never writes over it.
                if (existing && existing.rulesVersion > PROSE_RULES_VERSION && existing.textKey === textKey) return 'SUPERSEDED' as const;
                const checkId = await ProseCheckRepository.replaceCheck(
                    db,
                    workspaceId,
                    scene.bookId,
                    sceneId,
                    {
                        revision: current.revision,
                        textKey,
                        rulesVersion: PROSE_RULES_VERSION,
                        configKey: proseConfigKey(workspaceId, setup.sheet, setup.alexEnabled),
                        styleElementId: setup.sheet.elementId,
                        rulesNotRun: out.rulesNotRun.filter(isProseRuleId),
                        textCut: out.textCut,
                        findingsCut: out.findingsCut,
                        charsChecked: out.charsChecked,
                        wordsChecked: out.wordsChecked,
                        sentences: out.work.sentences,
                        readingEase: out.readability?.readingEase ?? null,
                        gradeLevel: out.readability?.gradeLevel ?? null,
                    },
                );
                await ProseFindingRepository.createMany(db, workspaceId, checkId, findings);
                return 'CHECKED' as const;
            },
            { timeout: 30_000 },
        );
        logger.info('prose check finished', { component: 'prose-checks', workspaceId, sceneId, outcome: stored, findings: findings.length, words: out.wordsChecked, ops: out.work.ops });
        return { outcome: stored, findings: stored === 'CHECKED' ? findings.length : 0 };
    });
    return result ?? { outcome: 'FAILED', findings: 0 };
}
