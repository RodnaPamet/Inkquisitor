/**
 * The question packs, read as plain data (Phase 2.2): every craft and
 * persona pack and its evaluation set loads and validates against the
 * content formats v1, and the validator refuses each defect a hand edit
 * could make (negative controls on the real files, mutated in memory).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BIBLE_KINDS } from '@/lib/bible/kinds';
import { getTemplate } from '@/lib/bible/templates';
import { PACKS_DIR, PACK_MAX_BYTES, getPacks, packDirOf, parseCraftEvals, parseCraftPack, parseExampleLine, parsePersonaPack } from '@/lib/interview/packs';
import { PERSONA_KEYS } from '@/lib/interview/vocabulary';

const read = (...p: string[]) => fs.readFileSync(path.join(PACKS_DIR, ...p), 'utf8');
const character = read('craft', 'character', 'PACK.md');
const socratic = read('personas', 'socratic', 'PACK.md');

it('loads every pack and evaluation set: fifteen craft packs, six personas', () => {
    const packs = getPacks();
    expect(Object.keys(packs.craft)).toEqual([...BIBLE_KINDS]);
    expect(Object.keys(packs.personas)).toEqual([...PERSONA_KEYS]);
    for (const kind of BIBLE_KINDS) {
        const core = getTemplate(kind).fields.filter((f) => f.required).map((f) => f.key);
        expect(packs.craft[kind].coverage).toEqual(expect.arrayContaining(core));
        expect(packs.craft[kind].examples.length).toBeGreaterThanOrEqual(10);
        expect(packs.craftEvals[kind].length).toBeGreaterThanOrEqual(8);
    }
    expect(packs.personaEvalCount).toBeGreaterThanOrEqual(36);
});

it('every file stays within the 8,192-byte bound', () => {
    for (const kind of BIBLE_KINDS) expect(Buffer.byteLength(read('craft', packDirOf(kind), 'PACK.md'))).toBeLessThanOrEqual(PACK_MAX_BYTES);
    for (const key of PERSONA_KEYS) expect(Buffer.byteLength(read('personas', key, 'PACK.md'))).toBeLessThanOrEqual(PACK_MAX_BYTES);
});

describe('example questions', () => {
    it('parse with their kind, keys, options and anchors', () => {
        expect(parseExampleLine('4. [EITHER_OR] (want) Would they admit it? Options: admit to it; keep it to themselves.')).toEqual({
            ok: true,
            number: 4,
            example: { kind: 'EITHER_OR', keys: ['want'], text: 'Would they admit it?', options: ['admit to it', 'keep it to themselves'], scaleLabels: null },
        });
        expect(parseExampleLine('7. [SCALE] (wound) How raw is it? Scale: 1 = long healed, 5 = still raw.')).toMatchObject({ ok: true, example: { scaleLabels: { low: 'long healed', high: 'still raw' } } });
    });

    it.each([
        ['no number', '[OPEN] (want) What do they want?'],
        ['a CHOICE with two options', '1. [CHOICE] (role) Which? Options: one; two.'],
        ['an EITHER_OR with three', '1. [EITHER_OR] (role) Which? Options: one; two; three.'],
        ['options on an OPEN question', '1. [OPEN] (role) Which? Options: one; two; three.'],
        ['a SCALE with no anchors', '1. [SCALE] (role) How much?'],
        ['no question mark', '1. [OPEN] (role) Tell me the role.'],
    ])('refuse %s', (_l, line) => {
        expect(parseExampleLine(line).ok).toBe(false);
    });
});

describe('a craft pack is refused for', () => {
    const refuse = (mutated: string) => expect(() => parseCraftPack(mutated, 'CHARACTER')).toThrow(/craft pack character/);

    it('nothing, as it stands (the controls below fail for their defect)', () => {
        expect(parseCraftPack(character, 'CHARACTER').name).toBe('craft-character');
    });
    it('a missing core key in its coverage', () => refuse(character.replace('  - wound\n', '')));
    it('a coverage key the template lacks', () => refuse(character.replace('  - role\n', '  - role\n  - eye_colour\n')));
    it('a fixed bullet reworded', () => refuse(character.replace('Never write the book', 'Do not write the book')));
    it('a heading renamed', () => refuse(character.replace('## Never ask', '## Do not ask')));
    it('a depth bullet missing', () => refuse(character.replace(/- \*\*Depth 5\*\* — .*\n/, '')));
    it('an example naming a key outside its coverage', () => refuse(character.replace('(want) What does this character', '(eye_colour) What does this character')));
    it('a broken example', () => refuse(character.replace('Options: admit to it; keep it to themselves.', 'Options: admit to it.')));
    it('the wrong name', () => refuse(character.replace('name: craft-character', 'name: craft-hero')));
    it('more than 8,192 bytes', () => refuse(character.replace('## Purpose\n', `## Purpose\n\n${'x'.repeat(PACK_MAX_BYTES)}\n`)));
});

describe('a persona pack is refused for', () => {
    const refuse = (mutated: string) => expect(() => parsePersonaPack(mutated, 'socratic')).toThrow(/persona pack socratic/);

    it('nothing, as it stands', () => {
        expect(parsePersonaPack(socratic, 'socratic').displayName).toBe('Socratic');
    });
    it('a fixed boundary reworded', () => refuse(socratic.replace('A persona changes how a question is worded', 'A persona may change')));
    it('a missing situation', () => refuse(socratic.replace('### S3', '### S4')));
    it('another persona’s key', () => refuse(socratic.replace('persona: socratic', 'persona: gentle-mentor')));
});

it('a craft evaluation set is refused when its bible state is not exactly the core keys', () => {
    const raw = read('craft', 'character', 'evals.json');
    expect(parseCraftEvals(raw, 'CHARACTER').length).toBeGreaterThanOrEqual(8);
    const cases = JSON.parse(raw) as Array<{ bibleState: Record<string, unknown> }>;
    cases[0].bibleState = { ...cases[0].bibleState, prominence: null };
    expect(() => parseCraftEvals(JSON.stringify(cases), 'CHARACTER')).toThrow(/core keys/);
});
