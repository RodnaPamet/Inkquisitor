/**
 * THE QUESTION PACKS, read as plain data (Phase 2.2; mounting since 2.3).
 *
 * A craft pack per element kind (`packs/craft/<dir>/PACK.md`) teaches the
 * interviewer how to question an element of that kind; the RELATIONS pack
 * (`packs/relations/PACK.md`, Phase 3.3, decision D24) how to question the
 * link between two elements, through the fields every relation type declares
 * (one pack for every type, its coverage every relation field key, its
 * evaluation set per type: a relation's questions are about a link, whatever
 * kinds it joins, so one craft guidance serves them and one record gates it,
 * D11 as for every pack); a persona pack
 * (`packs/personas/<key>/PACK.md`) shapes how a question is worded. Both are
 * original text written for Inkquisitor in the content formats v1 (sections
 * 3 and 4), each with the evaluation set beside it (`evals.json`); the persona
 * sets refer to the three fixed situations of `personas/situations.json`
 * (formats Appendix B).
 *
 * A pack is used two ways: its text goes into the generation prompt's fixed
 * instructions (it is product text, not author text), and a craft pack's
 * numbered EXAMPLE QUESTIONS are the fallback a field gets when no generated
 * question for it survives (`fillGapsFromPack`).
 *
 * Every file is validated with Zod when the registry first loads, against
 * the formats' rules a structure can carry: the frontmatter keys and values
 * in order, the exact headings, the 8,192-byte bound, the fixed bullets, the
 * five depth bullets, the example questions' grammar (and that each kind
 * appears twice and every core key once), the coverage list against the
 * kind's template, and the evaluation sets' shapes. A pack that breaks one
 * stops the registry from loading, so a bad edit fails every test, never a
 * request.
 *
 * MOUNTING (2.3, the lifted skill mount system: `pack-mount.ts`) reads three
 * more facts the registry records per pack, without deciding anything: the
 * pack's CONTENT HASH (`sha256:` over the file exactly as the prompt carries
 * it), its TEXT SCAN over every file (`pack-text-scan.ts`; a refused pack loads, is held
 * apart by rule id and never mounts) and its committed EVALUATION RECORD
 * (`evaluation-record.json`, read raw and hashed; `pack-evaluation.ts`
 * checks it).
 *
 * Read from disk at `process.cwd()` (as inflect-compliance reads its skill
 * corpus): the files stay readable Markdown — what the interviewer was told
 * is a question a reviewer asks — and the runtime image copies the directory
 * (Dockerfile). Server-only.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { BIBLE_KINDS, IDENTIFIER_MAX, IDENTIFIER_PATTERN, type BibleKind } from '@/lib/bible/kinds';
import { allRelationFieldKeys, getRelationType, getTemplate, relationFieldDefs } from '@/lib/bible/templates';
import { scanPackFiles, type PackFilesScan } from './pack-text-scan';
import { PERSONA_KEYS, QUESTION_KINDS, type PersonaKey, type QuestionKind } from './vocabulary';

export const PACK_MAX_BYTES = 8_192;
export const PACKS_DIR = path.join(process.cwd(), 'src/lib/interview/packs');

/** A kind's pack directory: the kind in lower case, underscores kept. */
export function packDirOf(kind: BibleKind): string {
    return kind.toLowerCase();
}

// ─── Example questions (content formats 3.3) ───────────────────────

export interface PackExample {
    kind: QuestionKind;
    keys: string[];
    text: string;
    options: string[] | null;
    scaleLabels: { low: string; high: string } | null;
}

const EXAMPLE_LINE = /^(\d+)\. \[(OPEN|CHOICE|EITHER_OR|SCENARIO|SCALE)\] \(([a-z0-9_]+(?:, [a-z0-9_]+)*)\) (.+)$/;

/** Parse one example question line, or explain why it is not one. */
export function parseExampleLine(line: string): { ok: true; number: number; example: PackExample } | { ok: false; problem: string } {
    const m = EXAMPLE_LINE.exec(line);
    if (!m) return { ok: false, problem: 'not in the form `N. [KIND] (keys) question`' };
    const kind = m[2] as QuestionKind;
    const keys = m[3].split(', ');
    let rest = m[4];
    let options: string[] | null = null;
    let scaleLabels: PackExample['scaleLabels'] = null;
    if (kind === 'CHOICE' || kind === 'EITHER_OR') {
        const at = rest.lastIndexOf(' Options: ');
        if (at === -1 || !rest.endsWith('.')) return { ok: false, problem: `${kind} without ` + '` Options: ….`' };
        options = rest.slice(at + ' Options: '.length, -1).split('; ');
        rest = rest.slice(0, at);
        const want = kind === 'CHOICE' ? options.length >= 3 && options.length <= 5 : options.length === 2;
        if (!want || options.some((o) => o.trim() === '')) return { ok: false, problem: `${kind} with ${options.length} options` };
    } else if (kind === 'SCALE') {
        const s = / Scale: 1 = (.+), 5 = (.+)\.$/.exec(rest);
        if (!s) return { ok: false, problem: 'SCALE without ` Scale: 1 = …, 5 = ….`' };
        scaleLabels = { low: s[1], high: s[2] };
        rest = rest.slice(0, s.index);
    } else if (/ (Options|Scale): /.test(rest)) {
        return { ok: false, problem: `${kind} carrying options or a scale` };
    }
    if (!rest.endsWith('?')) return { ok: false, problem: 'question does not end with `?`' };
    if (rest.length > 280) return { ok: false, problem: 'question longer than 280 characters' };
    return { ok: true, number: Number(m[1]), example: { kind, keys, text: rest, options, scaleLabels } };
}

// ─── Frontmatter ───────────────────────────────────────────────────

const DESCRIPTION = z.string().min(1).max(200).regex(/^[^"\\\n]+$/);

function readFrontmatter(raw: string, where: string): { fields: Array<[string, string | string[]]>; body: string } {
    if (!raw.startsWith('---\n')) throw new Error(`${where}: missing frontmatter`);
    const end = raw.indexOf('\n---\n', 4);
    if (end === -1) throw new Error(`${where}: unterminated frontmatter`);
    const fields: Array<[string, string | string[]]> = [];
    for (const line of raw.slice(4, end).split('\n')) {
        const item = /^ {2}- (\S+)$/.exec(line);
        if (item) {
            const last = fields[fields.length - 1];
            if (!last || !Array.isArray(last[1])) throw new Error(`${where}: a list item outside a list`);
            last[1].push(item[1]);
            continue;
        }
        const top = /^([a-z]+):(?: (.*))?$/.exec(line);
        if (!top) throw new Error(`${where}: unreadable frontmatter line`);
        fields.push([top[1], top[2] === undefined ? [] : top[2]]);
    }
    return { fields, body: raw.slice(end + 5) };
}

function unquote(value: string, where: string): string {
    const m = /^"(.*)"$/.exec(value);
    if (!m) throw new Error(`${where}: description must be double-quoted`);
    return m[1];
}

function headingsOf(body: string): string[] {
    return body.split('\n').filter((l) => /^#{1,3} /.test(l));
}

/** The lines of a section: from its heading to the next heading of the same or a higher level. */
function sectionLines(body: string, heading: string): string[] {
    const lines = body.split('\n');
    const start = lines.indexOf(heading);
    if (start === -1) return [];
    const level = heading.indexOf(' ');
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
        const m = /^(#{1,3}) /.exec(line);
        if (m && m[1].length <= level) break;
        out.push(line);
    }
    return out;
}

function bytesOf(raw: string): number {
    return Buffer.byteLength(raw, 'utf8');
}

// ─── Craft packs ───────────────────────────────────────────────────

export const CRAFT_FIXED_BULLETS = [
    "- Never write the book's prose or supply story content: ask, summarise the author's own answers, and challenge them.",
    "- Build any recommendation only from the author's stored entries and earlier answers, or from the options offered; when nothing supports one, offer none.",
];

const CRAFT_HEADINGS = (label: string) => [
    `# ${label}`,
    '## Purpose',
    '## How to question',
    '## Question patterns',
    '### OPEN',
    '### CHOICE',
    '### EITHER_OR',
    '### SCENARIO',
    '### SCALE',
    '## Depth guidance',
    '## Never ask',
    '## Example questions',
];

export interface CraftPack {
    name: string;
    version: number;
    kind: BibleKind;
    coverage: string[];
    description: string;
    /** The whole file, frontmatter included: what the prompt carries. */
    text: string;
    /** `sha256:` over `text`: what a session pins (2.3). */
    contentHash: string;
    examples: PackExample[];
}

export function parseCraftPack(raw: string, kind: BibleKind): CraftPack {
    const template = getTemplate(kind);
    const parsed = parseQuestionPack(raw, {
        where: `craft pack ${packDirOf(kind)}`,
        frontmatter: ['name', 'version', 'kind', 'coverage', 'description'],
        name: `craft-${packDirOf(kind)}`,
        kind,
        label: template.label,
        keys: template.fields.map((f) => f.key),
        core: template.fields.filter((f) => f.required).map((f) => f.key),
        ordered: true,
    });
    return { ...parsed, kind };
}

/** The relations pack's name (Phase 3.3): one pack for every relation type. */
export const RELATIONS_PACK_NAME = 'relations';

/** The relations pack (Phase 3.3, D24): a craft pack whose "template" is every relation field key. */
export type RelationsPack = Omit<CraftPack, 'kind'>;

/**
 * Parse the relations pack: the craft format, with `name, version, coverage,
 * description` (no kind), the heading `# Relations`, and a coverage that is
 * every relation field key any type declares, each once (`allRelationFieldKeys`;
 * in any order, since the keys come from several templates).
 */
export function parseRelationsPack(raw: string): RelationsPack {
    const { keys, required } = allRelationFieldKeys();
    return parseQuestionPack(raw, {
        where: 'relations pack',
        frontmatter: ['name', 'version', 'coverage', 'description'],
        name: RELATIONS_PACK_NAME,
        kind: null,
        label: 'Relations',
        keys,
        core: required,
        ordered: false,
    });
}

interface QuestionPackShape {
    where: string;
    frontmatter: readonly string[];
    name: string;
    kind: BibleKind | null;
    label: string;
    /** The keys the coverage may name, in order when `ordered`. */
    keys: readonly string[];
    /** The keys the coverage and the examples must cover. */
    core: readonly string[];
    /** The coverage follows `keys`' order (a kind's template); otherwise it names every key once. */
    ordered: boolean;
}

function parseQuestionPack(raw: string, shape: QuestionPackShape): RelationsPack {
    const where = shape.where;
    if (bytesOf(raw) > PACK_MAX_BYTES) throw new Error(`${where}: larger than ${PACK_MAX_BYTES} bytes`);
    const { fields, body } = readFrontmatter(raw, where);
    if (fields.map(([k]) => k).join(',') !== shape.frontmatter.join(',')) throw new Error(`${where}: frontmatter keys must be ${shape.frontmatter.join(', ')}`);
    const fm = Object.fromEntries(fields);
    const parsed = z
        .object({
            name: z.literal(shape.name),
            version: z.literal('1'),
            ...(shape.kind ? { kind: z.literal(shape.kind) } : {}),
            coverage: z.array(z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN)).min(1),
            description: z.string(),
        })
        .strict()
        .safeParse(fm);
    if (!parsed.success) throw new Error(`${where}: frontmatter ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const description = unquote(parsed.data.description, where);
    if (!DESCRIPTION.safeParse(description).success) throw new Error(`${where}: description is not one plain line of at most 200 characters`);

    const coverage = parsed.data.coverage;
    const templateKeys = shape.keys;
    const core = shape.core;
    if (coverage.some((k) => !templateKeys.includes(k))) throw new Error(`${where}: coverage names a key the template lacks`);
    if (core.some((k) => !coverage.includes(k))) throw new Error(`${where}: coverage misses a core key`);
    if (shape.ordered) {
        const orderOf = (k: string) => templateKeys.indexOf(k);
        if (coverage.some((k, i) => i > 0 && orderOf(coverage[i - 1]) >= orderOf(k))) throw new Error(`${where}: coverage is not in template order`);
    } else if (new Set(coverage).size !== coverage.length || coverage.length !== templateKeys.length) {
        throw new Error(`${where}: coverage must name every relation field key exactly once`);
    }

    if (headingsOf(body).join('\n') !== CRAFT_HEADINGS(shape.label).join('\n')) throw new Error(`${where}: headings are not exactly the format's`);
    const howTo = sectionLines(body, '## How to question').filter((l) => l.startsWith('- '));
    if (howTo[0] !== CRAFT_FIXED_BULLETS[0] || howTo[1] !== CRAFT_FIXED_BULLETS[1]) throw new Error(`${where}: the two fixed bullets do not open "How to question"`);
    const depth = sectionLines(body, '## Depth guidance').filter((l) => l.startsWith('- '));
    if (depth.length !== 5 || depth.some((l, i) => !l.startsWith(`- **Depth ${i + 1}** — `))) throw new Error(`${where}: depth guidance is not five bullets in the format's form`);

    const exampleLines = sectionLines(body, '## Example questions').filter((l) => l.trim() !== '');
    if (exampleLines.length < 10 || exampleLines.length > 20) throw new Error(`${where}: ${exampleLines.length} example questions (10 to 20)`);
    const examples: PackExample[] = [];
    exampleLines.forEach((line, i) => {
        const result = parseExampleLine(line);
        if (!result.ok) throw new Error(`${where}: example ${i + 1}: ${result.problem}`);
        if (result.number !== i + 1) throw new Error(`${where}: examples are not numbered 1..n`);
        if (result.example.keys.some((k) => !coverage.includes(k))) throw new Error(`${where}: example ${i + 1} names a key outside the coverage`);
        examples.push(result.example);
    });
    for (const k of QUESTION_KINDS) {
        if (examples.filter((e) => e.kind === k).length < 2) throw new Error(`${where}: fewer than two ${k} examples`);
    }
    for (const k of core) {
        if (!examples.some((e) => e.keys.includes(k))) throw new Error(`${where}: no example covers core key ${k}`);
    }
    return { name: parsed.data.name, version: 1, coverage, description, text: raw, contentHash: sha256Of(raw), examples };
}

// ─── Persona packs ─────────────────────────────────────────────────

export const PERSONA_DISPLAY_NAMES: Readonly<Record<PersonaKey, string>> = {
    'gentle-mentor': 'Gentle Mentor',
    'ruthless-editor': 'Ruthless Editor',
    socratic: 'Socratic',
    'devils-advocate': "Devil's Advocate",
    'target-reader': 'Target Reader',
    'genre-specialist': 'Genre Specialist',
    // Phase 4.3 (D29): the book-level panel's voices. Shown with a "Panel:" prefix (owner decision, 2026-11-26), so a
    // panel voice is never mistaken for its namesake among the six personas above.
    'panel-target-reader': 'Panel: Target Reader',
    'panel-ruthless-editor': 'Panel: Ruthless Editor',
    'panel-genre-specialist': 'Panel: Genre Specialist',
};

export const PERSONA_FIXED_BULLETS = [
    "- Never write the book's prose or supply story content: ask, summarise the author's own answers, and challenge them.",
    '- A persona changes how a question is worded, never which fields are asked about or what may be written to the bible.',
];

const PERSONA_HEADINGS = (display: string) => [
    `# ${display}`,
    '## Voice',
    '## Stance',
    '## Question style',
    '## Recommended-answer style',
    '## Boundaries',
    '## Examples',
    '### S1',
    '### S2',
    '### S3',
];

export interface PersonaPack {
    name: string;
    version: number;
    persona: PersonaKey;
    displayName: string;
    description: string;
    text: string;
    /** `sha256:` over `text`: what a session pins (2.3). */
    contentHash: string;
}

export function parsePersonaPack(raw: string, persona: PersonaKey): PersonaPack {
    const where = `persona pack ${persona}`;
    if (bytesOf(raw) > PACK_MAX_BYTES) throw new Error(`${where}: larger than ${PACK_MAX_BYTES} bytes`);
    const { fields, body } = readFrontmatter(raw, where);
    if (fields.map(([k]) => k).join(',') !== 'name,version,persona,description') throw new Error(`${where}: frontmatter keys must be name, version, persona, description`);
    const fm = Object.fromEntries(fields);
    const parsed = z
        .object({ name: z.literal(`persona-${persona}`), version: z.literal('1'), persona: z.literal(persona), description: z.string() })
        .safeParse(fm);
    if (!parsed.success) throw new Error(`${where}: frontmatter ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const description = unquote(parsed.data.description, where);
    if (!DESCRIPTION.safeParse(description).success) throw new Error(`${where}: description is not one plain line of at most 200 characters`);
    const displayName = PERSONA_DISPLAY_NAMES[persona];
    if (headingsOf(body).join('\n') !== PERSONA_HEADINGS(displayName).join('\n')) throw new Error(`${where}: headings are not exactly the format's`);
    const boundaries = sectionLines(body, '## Boundaries').filter((l) => l.startsWith('- '));
    if (boundaries[0] !== PERSONA_FIXED_BULLETS[0] || boundaries[1] !== PERSONA_FIXED_BULLETS[1]) throw new Error(`${where}: the two fixed bullets do not open "Boundaries"`);
    for (const s of ['### S1', '### S2', '### S3']) {
        const lines = sectionLines(body, s).filter((l) => l.trim() !== '');
        if (lines.length !== 2 || !lines[0].startsWith('Question: [') || !lines[1].startsWith('Recommended: ')) {
            throw new Error(`${where}: ${s.slice(4)} is not one Question line and one Recommended line`);
        }
    }
    return { name: parsed.data.name, version: 1, persona, displayName, description, text: raw, contentHash: sha256Of(raw) };
}

// ─── Evaluation sets beside the packs (shapes; graded by pack-evaluation.ts) ─

const CORE_VALUE = z.union([z.string().min(1).max(1_200), z.array(z.string().min(1).max(200)).min(1).max(12), z.number().int().min(1).max(5)]).nullable();
const DIALS = z.object({ depth: z.number().int().min(1).max(5), detail: z.number().int().min(1).max(5) }).strict();
const PRIOR_ANSWER = z
    .object({
        id: z.string().regex(/^a\d+$/),
        questionKind: z.enum(QUESTION_KINDS),
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).max(5).optional(),
        scaleLabels: z.object({ low: z.string().min(1), high: z.string().min(1) }).strict().optional(),
        targetsFieldKeys: z.array(z.string()).min(1),
        status: z.enum(['ANSWERED', 'SKIPPED', 'DECIDE_LATER']),
        answer: z.union([z.string().max(600), z.number().int().min(1).max(5)]).nullable(),
    })
    .strict();
export type PackPriorAnswer = z.infer<typeof PRIOR_ANSWER>;

const MUST_NOT = z.array(z.string().regex(/^[A-Z_]+$/)).min(1);

export const CraftEvalCaseSchema = z
    .object({
        id: z.string().regex(/^[a-z_]+-\d{2}$/),
        rationale: z.string().min(1).max(400),
        elementName: z.string().min(1).max(60),
        customLabel: z.string().min(1).max(40).optional(),
        bibleState: z.record(z.string(), CORE_VALUE),
        priorAnswers: z.array(PRIOR_ANSWER),
        dials: DIALS,
        expect: z.object({ targetsAnyOf: z.array(z.string()), mustNot: MUST_NOT }).strict(),
    })
    .strict();
export type CraftEvalCase = z.infer<typeof CraftEvalCaseSchema>;


/** One fixed persona situation (formats Appendix B), or an inline one. */
export const SituationSchema = z
    .object({
        kind: z.enum(BIBLE_KINDS),
        elementName: z.string().min(1).max(60),
        customLabel: z.string().min(1).max(40).optional(),
        bibleState: z.record(z.string(), CORE_VALUE),
        priorAnswers: z.array(PRIOR_ANSWER),
        dials: DIALS,
    })
    .strict();
export type Situation = z.infer<typeof SituationSchema>;

export const SITUATION_IDS = ['S1', 'S2', 'S3'] as const;
export type SituationId = (typeof SITUATION_IDS)[number];

export const PersonaEvalCaseSchema = z
    .object({
        id: z.string().regex(/^[a-z-]+-\d{2}$/),
        rationale: z.string().min(1).max(400),
        situation: z.union([z.enum(SITUATION_IDS), SituationSchema]),
        expect: z.object({ tone: z.array(z.string()).min(1).max(3), mustNot: MUST_NOT }).strict(),
    })
    .strict();

function parseEvals<T>(raw: string, schema: z.ZodType<T>, where: string, idPrefix: string, min: number, max: number): T[] {
    const cases = z.array(schema).min(min).max(max).safeParse(JSON.parse(raw));
    if (!cases.success) throw new Error(`${where}: ${cases.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    cases.data.forEach((c, i) => {
        const id = (c as { id: string }).id;
        if (id !== `${idPrefix}-${String(i + 1).padStart(2, '0')}`) throw new Error(`${where}: case ids are not ${idPrefix}-01.. in order`);
    });
    return cases.data;
}

export function parseCraftEvals(raw: string, kind: BibleKind): CraftEvalCase[] {
    const where = `craft evals ${packDirOf(kind)}`;
    const cases = parseEvals(raw, CraftEvalCaseSchema, where, packDirOf(kind), 8, 15);
    const core = getTemplate(kind)
        .fields.filter((f) => f.required)
        .map((f) => f.key);
    for (const c of cases) {
        if (Object.keys(c.bibleState).join(',') !== core.join(',')) throw new Error(`${where}: ${c.id}'s bibleState is not exactly the core keys in order`);
        if ((kind === 'CUSTOM') !== (c.customLabel !== undefined)) throw new Error(`${where}: ${c.id}: a custom label belongs to custom cases only`);
    }
    return cases;
}

export type PersonaEvalCase = z.infer<typeof PersonaEvalCaseSchema>;

/**
 * One case of the relations pack's set (Phase 3.3): a relation of a type
 * between two named elements, its stored core fields, and what a right round
 * targets. `bibleState` names exactly the type's core relation fields, in order.
 */
export const RelationEvalCaseSchema = z
    .object({
        id: z.string().regex(/^relations-\d{2}$/),
        rationale: z.string().min(1).max(400),
        fromKind: z.enum(BIBLE_KINDS),
        relationType: z.string().max(IDENTIFIER_MAX).regex(IDENTIFIER_PATTERN),
        fromName: z.string().min(1).max(60),
        toName: z.string().min(1).max(60),
        bibleState: z.record(z.string(), z.string().min(1).max(1_200).nullable()),
        priorAnswers: z.array(PRIOR_ANSWER),
        dials: DIALS,
        expect: z.object({ targetsAnyOf: z.array(z.string()), mustNot: MUST_NOT }).strict(),
    })
    .strict();
export type RelationEvalCase = z.infer<typeof RelationEvalCaseSchema>;

export function parseRelationEvals(raw: string): RelationEvalCase[] {
    const where = 'relations evals';
    const cases = parseEvals(raw, RelationEvalCaseSchema, where, 'relations', 8, 15);
    for (const c of cases) {
        if (!getRelationType(c.fromKind, c.relationType)) throw new Error(`${where}: ${c.id} names a relation type ${c.fromKind} does not declare`);
        const core = relationFieldDefs(c.fromKind, c.relationType)
            .filter((f) => f.required)
            .map((f) => f.key);
        if (Object.keys(c.bibleState).join(',') !== core.join(',')) throw new Error(`${where}: ${c.id}'s bibleState is not exactly the type's core keys in order`);
    }
    return cases;
}

export function parsePersonaEvals(raw: string, persona: PersonaKey): PersonaEvalCase[] {
    return parseEvals(raw, PersonaEvalCaseSchema, `persona evals ${persona}`, persona, 6, 10);
}

/** The fixed situations every persona's examples and evaluation set refer to (formats Appendix B). */
export function parseSituations(raw: string): Record<SituationId, Situation> {
    const parsed = z.object({ S1: SituationSchema, S2: SituationSchema, S3: SituationSchema }).strict().safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`persona situations: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    for (const id of SITUATION_IDS) {
        const s = parsed.data[id];
        const core = getTemplate(s.kind)
            .fields.filter((f) => f.required)
            .map((f) => f.key);
        if (Object.keys(s.bibleState).join(',') !== core.join(',')) throw new Error(`persona situations: ${id}'s bibleState is not exactly the core keys in order`);
    }
    return parsed.data;
}

// ─── Hashes ────────────────────────────────────────────────────────

/** `sha256:` over text exactly as given, UTF-8: a pack's content hash, an evaluation set's, a record's. */
export function sha256Of(text: string): string {
    return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** A persona's evaluation set is its `evals.json` AND the situations it refers to: both are hashed. */
export function personaSetHash(evalsRaw: string, situationsRaw: string): string {
    return sha256Of(`${evalsRaw}\n\u0000situations.json\n${situationsRaw}`);
}

// ─── The registry ──────────────────────────────────────────────────

/** The file an evaluation run writes beside a pack (`npm run packs:evaluate`). */
export const PACK_RECORD_FILE = 'evaluation-record.json';
export const SITUATIONS_FILE = 'situations.json';

export type PackGroup = 'craft' | 'persona' | 'relations';

/**
 * What mounting reads about one pack: its identity, the hashes that pin it,
 * its text scan, and its committed evaluation record (raw: `pack-evaluation.ts`
 * checks it). Nothing here decides whether the pack mounts.
 */
export interface PackFile {
    /** `craft-character`, `persona-socratic`, … (the frontmatter `name`). */
    name: string;
    group: PackGroup;
    /** The element kind (craft), the persona key (persona), or `relations`. */
    key: string;
    version: number;
    /** Relative to the packs directory: `craft/character`, `personas/socratic`. */
    dir: string;
    /** `sha256:` over PACK.md exactly as the prompt carries it. */
    contentHash: string;
    /** `sha256:` over the evaluation set (a persona's includes the situations). */
    setHash: string;
    /** The load-time text scan over every file of the pack (PACK.md, evals.json, and a persona's situations.json). */
    scan: PackFilesScan;
    /** The committed record: absent, unreadable (JSON), or read with its file's hash. */
    record: { state: 'absent' } | { state: 'unreadable'; error: string } | { state: 'present'; raw: unknown; hash: string };
}

export interface PackRegistry {
    craft: Readonly<Record<BibleKind, CraftPack>>;
    /** Phase 3.3: the one pack for every relation's fields. */
    relations: RelationsPack;
    personas: Readonly<Record<PersonaKey, PersonaPack>>;
    craftEvals: Readonly<Record<BibleKind, CraftEvalCase[]>>;
    relationEvals: readonly RelationEvalCase[];
    personaEvals: Readonly<Record<PersonaKey, PersonaEvalCase[]>>;
    situations: Readonly<Record<SituationId, Situation>>;
    /**
     * Each persona's situations (Phase 4.3): its own `situations.json` beside its pack when it has one (the
     * book-level panel's), else the shared file's.
     */
    personaSituations: Readonly<Record<PersonaKey, Readonly<Record<SituationId, Situation>>>>;
    /** Every pack, by name: 16 craft (one per kind), the relations pack, then the personas. */
    files: Readonly<Record<string, PackFile>>;
    personaEvalCount: number;
}

export function craftPackName(kind: BibleKind): string {
    return `craft-${packDirOf(kind)}`;
}

export function personaPackName(persona: PersonaKey): string {
    return `persona-${persona}`;
}

function readRecord(dir: string): PackFile['record'] {
    const full = path.join(dir, PACK_RECORD_FILE);
    if (!fs.existsSync(full)) return { state: 'absent' };
    const text = fs.readFileSync(full, 'utf8');
    try {
        return { state: 'present', raw: JSON.parse(text) as unknown, hash: sha256Of(text) };
    } catch (err) {
        return { state: 'unreadable', error: err instanceof Error ? err.name : 'unreadable' };
    }
}

/** Load and validate every pack and evaluation set under `dir`. Throws, naming the file, on the first problem of shape. */
export function loadPacks(dir: string = PACKS_DIR): PackRegistry {
    const read = (...parts: string[]) => fs.readFileSync(path.join(dir, ...parts), 'utf8');
    const craft = {} as Record<BibleKind, CraftPack>;
    const craftEvals = {} as Record<BibleKind, CraftEvalCase[]>;
    const files: Record<string, PackFile> = {};
    for (const kind of BIBLE_KINDS) {
        const rel = path.join('craft', packDirOf(kind));
        const raw = read(rel, 'PACK.md');
        const evalsRaw = read(rel, 'evals.json');
        craft[kind] = parseCraftPack(raw, kind);
        craftEvals[kind] = parseCraftEvals(evalsRaw, kind);
        files[craft[kind].name] = {
            name: craft[kind].name,
            group: 'craft',
            key: kind,
            version: craft[kind].version,
            dir: rel,
            contentHash: craft[kind].contentHash,
            setHash: sha256Of(evalsRaw),
            scan: scanPackFiles([
                ['PACK.md', raw],
                ['evals.json', evalsRaw],
            ]),
            record: readRecord(path.join(dir, rel)),
        };
    }
    const relationsRaw = read('relations', 'PACK.md');
    const relationEvalsRaw = read('relations', 'evals.json');
    const relations = parseRelationsPack(relationsRaw);
    const relationEvals = parseRelationEvals(relationEvalsRaw);
    files[relations.name] = {
        name: relations.name,
        group: 'relations',
        key: RELATIONS_PACK_NAME,
        version: relations.version,
        dir: 'relations',
        contentHash: relations.contentHash,
        setHash: sha256Of(relationEvalsRaw),
        scan: scanPackFiles([
            ['PACK.md', relationsRaw],
            ['evals.json', relationEvalsRaw],
        ]),
        record: readRecord(path.join(dir, 'relations')),
    };
    const situationsRaw = read('personas', SITUATIONS_FILE);
    const situations = parseSituations(situationsRaw);
    const personas = {} as Record<PersonaKey, PersonaPack>;
    const personaEvals = {} as Record<PersonaKey, PersonaEvalCase[]>;
    const personaSituations = {} as Record<PersonaKey, Record<SituationId, Situation>>;
    let personaEvalCount = 0;
    for (const key of PERSONA_KEYS) {
        const rel = path.join('personas', key);
        const raw = read(rel, 'PACK.md');
        const evalsRaw = read(rel, 'evals.json');
        // Phase 4.3: a persona with situations of its own (the book-level panel's) is evaluated against them.
        const ownSituations = fs.existsSync(path.join(dir, rel, SITUATIONS_FILE));
        const mySituationsRaw = ownSituations ? read(rel, SITUATIONS_FILE) : situationsRaw;
        personaSituations[key] = ownSituations ? parseSituations(mySituationsRaw) : situations;
        personas[key] = parsePersonaPack(raw, key);
        personaEvals[key] = parsePersonaEvals(evalsRaw, key);
        personaEvalCount += personaEvals[key].length;
        files[personas[key].name] = {
            name: personas[key].name,
            group: 'persona',
            key,
            version: personas[key].version,
            dir: rel,
            contentHash: personas[key].contentHash,
            setHash: personaSetHash(evalsRaw, mySituationsRaw),
            scan: scanPackFiles([
                ['PACK.md', raw],
                ['evals.json', evalsRaw],
                [SITUATIONS_FILE, mySituationsRaw],
            ]),
            record: readRecord(path.join(dir, rel)),
        };
    }
    return { craft, relations, personas, craftEvals, relationEvals, personaEvals, situations, personaSituations, files, personaEvalCount };
}

let registry: PackRegistry | undefined;

/** The deployment's packs, loaded and validated once. */
export function getPacks(): PackRegistry {
    registry ??= loadPacks();
    return registry;
}
