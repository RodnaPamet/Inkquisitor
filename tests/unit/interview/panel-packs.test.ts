/**
 * THE BOOK-LEVEL PANEL'S PERSONA PACKS (Phase 4.3, D29): Target Reader,
 * Ruthless Editor and Genre Specialist as three persona packs with situations
 * and evaluation sets of their own, original text, passing the load-time scan,
 * mounting on their structural records in development and test (D11).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPacks, PACKS_DIR, personaPackName } from '@/lib/interview/packs';
import { evalCasesOf } from '@/lib/interview/pack-evaluation';
import { deploymentPackMounts } from '@/app-layer/usecases/interview-packs';
import { PANEL_PERSONA_KEYS } from '@/lib/interview/vocabulary';

const packs = getPacks();
const PANEL_DISPLAY_NAMES: Record<(typeof PANEL_PERSONA_KEYS)[number], string> = {
    'panel-target-reader': 'Panel: Target Reader',
    'panel-ruthless-editor': 'Panel: Ruthless Editor',
    'panel-genre-specialist': 'Panel: Genre Specialist',
};
const MESSAGES = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'messages', 'en.json'), 'utf8')) as {
    interview: { personas: Record<string, { name: string }> };
};
const BANNED = ['save the cat', 'story grid', 'dramatica', 'snowflake', "hero's journey", 'hero’s journey', 'monomyth'];

it.each(PANEL_PERSONA_KEYS)('%s loads with its own situations, its own set, and a clean text scan', (key) => {
    const file = packs.files[personaPackName(key)];
    expect(file).toMatchObject({ group: 'persona', key, dir: `personas/${key}` });
    expect(file.scan.rules).toEqual([]);
    // Owner decision (2026-11-26): a panel voice is shown with a "Panel:" prefix, never under its namesake's bare name.
    expect(packs.personas[key].displayName).toBe(PANEL_DISPLAY_NAMES[key]);
    expect(MESSAGES.interview.personas[key].name).toBe(PANEL_DISPLAY_NAMES[key]);
    // Its situations are its own file's, not the shared one's.
    expect(fs.existsSync(path.join(PACKS_DIR, 'personas', key, 'situations.json'))).toBe(true);
    expect(packs.personaSituations[key].S1.kind).toBe('PREMISE');
    expect(packs.personaSituations[key]).not.toBe(packs.situations);
    const cases = evalCasesOf(packs, file.name);
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.map((c) => c.expectTargets)).toEqual(expect.arrayContaining([['stakes'], ['climax'], ['counter_argument']]));
    const text = fs.readFileSync(path.join(PACKS_DIR, 'personas', key, 'PACK.md'), 'utf8').toLowerCase();
    for (const term of BANNED) expect(text).not.toContain(term);
});

it('a changed situation changes the pack’s set hash (a record made over the old one no longer mounts)', () => {
    const file = packs.files[personaPackName('panel-target-reader')];
    const shared = packs.files[personaPackName('target-reader')];
    expect(file.setHash).not.toBe(shared.setHash);
});

it('every panel pack mounts in development and test, on its structural record', async () => {
    const names = PANEL_PERSONA_KEYS.map(personaPackName);
    const verdicts = await deploymentPackMounts(packs, 'structural', names);
    for (const n of names) expect([n, verdicts.get(n)?.ok]).toEqual([n, true]);
});

it('the six personas keep their own names, distinct from every panel voice’s', () => {
    expect(packs.personas['target-reader'].displayName).toBe('Target Reader');
    expect(packs.personas['ruthless-editor'].displayName).toBe('Ruthless Editor');
    expect(packs.personas['genre-specialist'].displayName).toBe('Genre Specialist');
    const names = Object.values(packs.personas).map((p) => p.displayName);
    expect(new Set(names).size).toBe(names.length);
});
