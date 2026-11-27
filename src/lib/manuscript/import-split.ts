/**
 * AN IMPORT'S SPLIT (Phase 5.1, D33): a document read as blocks (4.0's reader:
 * DOCX through mammoth in its bounded worker, Markdown by its own reader)
 * becomes parts, chapters and scenes at its headings — and only once the
 * author has seen and confirmed the split.
 *
 *   outlineOf      the preview: every heading (its level, its words, and the
 *                  words of the section under it), the levels the document
 *                  uses and how many scene breaks (`***`, a rule) it holds
 *   defaultPlan    the split proposed first: the deepest three heading levels
 *                  in use as part / chapter / scene (two: chapter / scene; one:
 *                  chapters only), scene breaks as scene splits when there are any
 *   splitManuscript the confirmed plan applied: each heading takes its level's
 *                  role unless the author overrode it (`part`, `chapter`,
 *                  `scene`, or `text` — no break, its words kept as a paragraph
 *                  of the section before); text before the first heading lands
 *                  in an untitled part, chapter and scene
 *
 * ONE PASS over the blocks, and every heading's role is a map lookup: the work
 * is linear in the document (`work` counts it, and a test holds a 150,000-word
 * manuscript to it — 5.H times the whole import). Pure, and client-safe in
 * its types: no imports but the vocabulary and the word count.
 */
import type { DocBlock } from '@/lib/sources/document';
import { IMPORT_OVERRIDES_MAX, IMPORT_ROLES, type ImportRole } from './vocabulary';
import { countWords } from './word-count';

export interface OutlineHeading {
    /** Its place among the document's headings, 0-based (what an override names). */
    readonly index: number;
    readonly level: number;
    readonly text: string;
    /** Words of the paragraphs under it, up to the next heading. */
    readonly sectionWords: number;
    /**
     * Its words are too long to be stored as a title (`MANUSCRIPT_TITLE_MAX`
     * after sanitising; set by the server, which sanitises): a paragraph styled
     * as a heading. The proposed split keeps it as text, and a plan that makes
     * it a title is refused `HEADING_TOO_LONG` — never cut to fit.
     */
    readonly titleTooLong?: boolean;
}

export interface ImportOutline {
    readonly headings: readonly OutlineHeading[];
    /** The heading levels the document uses, ascending (1 is the outermost). */
    readonly levels: readonly number[];
    readonly sceneBreaks: number;
    readonly paragraphs: number;
    readonly words: number;
    /** Words of the paragraphs before the first heading (they land in an untitled chapter and scene). */
    readonly preambleWords: number;
}

export interface ImportPlan {
    /** The heading level that starts a part, a chapter and a scene; null: none does. Distinct when set. */
    readonly levels: { readonly part: number | null; readonly chapter: number | null; readonly scene: number | null };
    /** A scene break (`***`, a rule) starts a new scene. */
    readonly sceneBreaks: boolean;
    /** The author's changes, heading by heading: [heading index, role]. */
    readonly overrides: ReadonlyArray<readonly [number, ImportRole]>;
}

export interface SplitScene {
    readonly title: string | null;
    readonly paragraphs: string[];
}
export interface SplitChapter {
    readonly title: string | null;
    readonly scenes: SplitScene[];
}
export interface SplitPart {
    readonly title: string | null;
    readonly chapters: SplitChapter[];
}

export interface SplitResult {
    readonly parts: SplitPart[];
    readonly counts: { readonly parts: number; readonly chapters: number; readonly scenes: number; readonly words: number };
    /** Blocks visited (the work is one visit a block). */
    readonly work: number;
}

export type PlanProblem = 'LEVELS_NOT_DISTINCT' | 'LEVEL_UNUSED' | 'OVERRIDE_OUT_OF_RANGE' | 'OVERRIDE_DUPLICATE' | 'OVERRIDE_ROLE' | 'TOO_MANY_OVERRIDES' | 'HEADING_TOO_LONG';

/** The preview of a document's blocks. */
export function outlineOf(blocks: readonly DocBlock[]): ImportOutline {
    const headings: OutlineHeading[] = [];
    const levels = new Set<number>();
    let sceneBreaks = 0;
    let paragraphs = 0;
    let words = 0;
    let section = 0;
    let preambleWords = 0;
    let current: { index: number; level: number; text: string } | null = null;
    const close = () => {
        if (current) headings.push({ ...current, sectionWords: section });
        else preambleWords = section;
        section = 0;
    };
    for (const b of blocks) {
        if (b.kind === 'heading') {
            close();
            current = { index: headings.length, level: b.level, text: b.text };
            levels.add(b.level);
            words += countWords(b.text);
        } else if (b.kind === 'para') {
            const n = countWords(b.text);
            paragraphs += 1;
            words += n;
            section += n;
        } else {
            sceneBreaks += 1;
        }
    }
    close();
    return { headings, levels: [...levels].sort((a, b) => a - b), sceneBreaks, paragraphs, words, preambleWords };
}

/** The split proposed before the author changes anything. */
export function defaultPlan(outline: ImportOutline): ImportPlan {
    const l = outline.levels;
    const levels =
        l.length >= 3
            ? { part: l[0], chapter: l[1], scene: l[2] }
            : l.length === 2
              ? { part: null, chapter: l[0], scene: l[1] }
              : l.length === 1
                ? { part: null, chapter: l[0], scene: null }
                : { part: null, chapter: null, scene: null };
    // A heading too long to be a title is kept as text (its words a paragraph of the section before), never cut.
    const plan: ImportPlan = { levels, sceneBreaks: outline.sceneBreaks > 0, overrides: [] };
    const noOverrides = new Map<number, ImportRole>();
    const overrides = outline.headings.filter((h) => h.titleTooLong && roleOf(plan, noOverrides, h.index, h.level) !== 'text').map((h) => [h.index, 'text'] as const);
    return { ...plan, overrides };
}

/** What is wrong with a plan for this outline: EVERY problem, in a fixed order (none: an empty list). */
export function planProblems(plan: ImportPlan, outline: ImportOutline): { problems: PlanProblem[]; longHeadings: number[] } {
    const problems = new Set<PlanProblem>();
    const set = [plan.levels.part, plan.levels.chapter, plan.levels.scene].filter((v): v is number => v !== null);
    if (new Set(set).size !== set.length) problems.add('LEVELS_NOT_DISTINCT');
    if (set.some((v) => !outline.levels.includes(v))) problems.add('LEVEL_UNUSED');
    if (plan.overrides.length > IMPORT_OVERRIDES_MAX) problems.add('TOO_MANY_OVERRIDES');
    const seen = new Set<number>();
    for (const [index, role] of plan.overrides.slice(0, IMPORT_OVERRIDES_MAX)) {
        if (!Number.isInteger(index) || index < 0 || index >= outline.headings.length) problems.add('OVERRIDE_OUT_OF_RANGE');
        else if (seen.has(index)) problems.add('OVERRIDE_DUPLICATE');
        if (!(IMPORT_ROLES as readonly string[]).includes(role)) problems.add('OVERRIDE_ROLE');
        seen.add(index);
    }
    const longHeadings: number[] = [];
    if (problems.size === 0) {
        // Only for a plan otherwise sound: a role is read through its overrides.
        const overrides = new Map<number, ImportRole>(plan.overrides.map(([i, r]) => [i, r] as const));
        for (const h of outline.headings) if (h.titleTooLong && roleOf(plan, overrides, h.index, h.level) !== 'text') longHeadings.push(h.index);
        if (longHeadings.length > 0) problems.add('HEADING_TOO_LONG');
    }
    return { problems: [...problems], longHeadings };
}

/** The first problem of a plan for this outline, or null. */
export function planProblem(plan: ImportPlan, outline: ImportOutline): PlanProblem | null {
    return planProblems(plan, outline).problems[0] ?? null;
}

/** The role a heading of `level` at `index` takes under the plan. */
export function roleOf(plan: ImportPlan, overrides: ReadonlyMap<number, ImportRole>, index: number, level: number): ImportRole {
    const o = overrides.get(index);
    if (o) return o;
    if (level === plan.levels.part) return 'part';
    if (level === plan.levels.chapter) return 'chapter';
    if (level === plan.levels.scene) return 'scene';
    return 'text';
}

/** Apply a (checked) plan to the blocks: one pass. */
export function splitManuscript(blocks: readonly DocBlock[], plan: ImportPlan): SplitResult {
    const overrides = new Map<number, ImportRole>(plan.overrides.map(([i, r]) => [i, r] as const));
    const parts: SplitPart[] = [];
    let part: SplitPart | null = null;
    let chapter: SplitChapter | null = null;
    let scene: SplitScene | null = null;
    let chapters = 0;
    let scenes = 0;
    let words = 0;
    let work = 0;
    let headingIndex = 0;
    const ensurePart = (): SplitPart => {
        if (!part) {
            part = { title: null, chapters: [] };
            parts.push(part);
        }
        return part;
    };
    const ensureChapter = (): SplitChapter => {
        if (!chapter) {
            chapter = { title: null, scenes: [] };
            ensurePart().chapters.push(chapter);
            chapters += 1;
        }
        return chapter;
    };
    const ensureScene = (): SplitScene => {
        if (!scene) {
            scene = { title: null, paragraphs: [] };
            ensureChapter().scenes.push(scene);
            scenes += 1;
        }
        return scene;
    };
    for (const b of blocks) {
        work += 1;
        if (b.kind === 'heading') {
            const role = roleOf(plan, overrides, headingIndex, b.level);
            headingIndex += 1;
            if (role === 'part') {
                part = { title: b.text, chapters: [] };
                parts.push(part);
                chapter = null;
                scene = null;
            } else if (role === 'chapter') {
                ensurePart();
                chapter = { title: b.text, scenes: [] };
                part!.chapters.push(chapter);
                chapters += 1;
                scene = null;
            } else if (role === 'scene') {
                ensureChapter();
                scene = { title: b.text, paragraphs: [] };
                chapter!.scenes.push(scene);
                scenes += 1;
            } else {
                ensureScene().paragraphs.push(b.text);
                words += countWords(b.text);
            }
        } else if (b.kind === 'para') {
            ensureScene().paragraphs.push(b.text);
            words += countWords(b.text);
        } else if (plan.sceneBreaks && scene !== null && (scene as SplitScene).paragraphs.length > 0) {
            // The next paragraph starts a new, untitled scene of the same chapter.
            scene = null;
        }
    }
    return { parts, counts: { parts: parts.length, chapters, scenes, words }, work };
}

export interface PlanSummary {
    readonly parts: number;
    readonly chapters: number;
    /** Scenes started by headings (scene breaks may add more: `outline.sceneBreaks`). */
    readonly scenes: number;
    readonly words: number;
}

/**
 * What a plan would make, read from the OUTLINE alone (the preview, in the
 * browser: it holds the headings, not the paragraphs). The same walk as
 * `splitManuscript` over the headings, each heading's section standing for its
 * paragraphs; a scene break is not placed (the outline does not say where), so
 * the scenes are the headings' and the server's confirm answers the exact count.
 */
export function planSummary(outline: ImportOutline, plan: ImportPlan): PlanSummary {
    const overrides = new Map<number, ImportRole>(plan.overrides.map(([i, r]) => [i, r] as const));
    let parts = 0;
    let chapters = 0;
    let scenes = 0;
    let part = false;
    let chapter = false;
    let scene = false;
    const openPart = () => {
        if (!part) {
            parts += 1;
            part = true;
        }
    };
    const openChapter = () => {
        openPart();
        if (!chapter) {
            chapters += 1;
            chapter = true;
        }
    };
    const openScene = () => {
        openChapter();
        if (!scene) {
            scenes += 1;
            scene = true;
        }
    };
    if (outline.preambleWords > 0) openScene();
    for (const h of outline.headings) {
        const role = roleOf(plan, overrides, h.index, h.level);
        if (role === 'part') {
            parts += 1;
            part = true;
            chapter = false;
            scene = false;
        } else if (role === 'chapter') {
            openPart();
            chapters += 1;
            chapter = true;
            scene = false;
        } else if (role === 'scene') {
            openChapter();
            scenes += 1;
            scene = true;
        } else {
            openScene();
        }
        if (h.sectionWords > 0) openScene();
    }
    return { parts, chapters, scenes, words: outline.words };
}
