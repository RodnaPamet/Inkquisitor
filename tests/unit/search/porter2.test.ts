/**
 * The Snowball English stemmer (Phase 3.4, decision D21) against Snowball's
 * own golden data: every word of the project's English vocabulary
 * (`voc.txt`, 42,649 words) stems to exactly the stem in its `output.txt`,
 * both at snowballstem/snowball-data commit
 * 019921c3a41c2b70063ee3feb215a00c8e594597 (BSD-3-Clause,
 * `tests/fixtures/snowball/COPYING`).
 *
 * THE PIN: `golden-pin.json` names the stemmer version the golden data was
 * checked under, with both files' SHA-256, and the version names the
 * algorithm commit the pin records. `VERSION_PINS` below holds each version's
 * hashes as written when that version was pinned, and an entry is never
 * edited: replacing the fixtures (a newer Snowball) without moving
 * `PORTER2_VERSION` fails here (the file's hashes no longer match the
 * version's entry, even with `golden-pin.json` re-pinned), and so does moving
 * the version without re-pinning; and any edit to `porter2.ts` that moves one
 * stem fails the golden comparison.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { porter2Stem, PORTER2_VERSION } from '@/lib/search/porter2';
import { stemNeedle } from '@/lib/search/rank';

const DIR = path.resolve(__dirname, '../../fixtures/snowball/english');
const vocText = fs.readFileSync(path.join(DIR, 'voc.txt'), 'utf8');
const outText = fs.readFileSync(path.join(DIR, 'output.txt'), 'utf8');
const pin = JSON.parse(fs.readFileSync(path.join(DIR, 'golden-pin.json'), 'utf8')) as { porter2Version: string; algorithm: string; vocabularySha256: string; outputSha256: string };
const voc = vocText.split('\n').filter((w) => w !== '');
const out = outText.split('\n').filter((w, i, all) => w !== '' || i < all.length - 1);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Each stemmer version's golden data, as pinned with it. Add an entry for a new version; never edit one. */
const VERSION_PINS: Readonly<Record<string, { vocabularySha256: string; outputSha256: string }>> = {
    'snowball-english-06e1f74f': {
        vocabularySha256: '9e44b83e85d8b9c41ed40a0dd0d17a3ca9e7eb3a04683992982e7834f96ebc0f',
        outputSha256: '8bb926ad62d3f4bb067f530ae754cee26ecd48de56192629af4dba32c34991a6',
    },
};

describe('the golden data', () => {
    it('is the pinned vocabulary and output, pinned to this stemmer version', () => {
        expect(sha256(vocText)).toBe(pin.vocabularySha256);
        expect(sha256(outText)).toBe(pin.outputSha256);
        expect(PORTER2_VERSION).toBe(pin.porter2Version);
    });

    it("is the data this version was pinned with, and the version names the pin's algorithm commit", () => {
        // A newer Snowball (new fixtures, `golden-pin.json` re-pinned) under the OLD version fails here.
        expect(VERSION_PINS[PORTER2_VERSION]).toEqual({ vocabularySha256: sha256(vocText), outputSha256: sha256(outText) });
        const commit = /\bat ([0-9a-f]{40})$/.exec(pin.algorithm)?.[1];
        expect(commit).toBeDefined();
        expect(PORTER2_VERSION).toBe(`snowball-english-${commit!.slice(0, 8)}`);
    });

    it('is the whole vocabulary (a short read would pass vacuously)', () => {
        expect(voc).toHaveLength(42_649);
        expect(out.length).toBeGreaterThanOrEqual(voc.length);
    });
});

it("stems every word of Snowball's English vocabulary to Snowball's own stem", () => {
    const wrong: string[] = [];
    voc.forEach((word, i) => {
        const stem = porter2Stem(word);
        if (stem !== out[i]) wrong.push(`${word} → ${stem} (expected ${out[i]})`);
    });
    expect(wrong.slice(0, 20)).toEqual([]);
    expect(wrong).toHaveLength(0);
});

describe('the parts of the algorithm, by name', () => {
    it.each([
        // exception1: special changes, the -LY cases and invariant forms
        ['skis', 'ski'],
        ['skies', 'sky'],
        ['idly', 'idl'],
        ['gently', 'gentl'],
        ['ugly', 'ugli'],
        ['early', 'earli'],
        ['only', 'onli'],
        ['singly', 'singl'],
        ['sky', 'sky'],
        ['news', 'news'],
        ['howe', 'howe'],
        ['atlas', 'atlas'],
        ['cosmos', 'cosmos'],
        ['bias', 'bias'],
        ['andes', 'andes'],
        // words of one or two letters are left alone
        ['a', 'a'],
        ['is', 'is'],
        // the region prefixes (gener, commun, arsen and the later revisions) set R1 after them, so words
        // that only share the prefix stay apart: general / generic / generous, arsenic / arsenal, …
        ['generate', 'generat'],
        ['general', 'general'],
        ['generic', 'generic'],
        ['generously', 'generous'],
        ['communication', 'communic'],
        ['community', 'communiti'],
        ['arsenic', 'arsenic'],
        ['arsenal', 'arsenal'],
        ['universe', 'univers'],
        ['universal', 'universal'],
        ['university', 'universiti'],
        ['emergency', 'emergenc'],
        ['lateral', 'lateral'],
        ['pasted', 'paste'],
        ['organization', 'organiz'],
        ['organic', 'organic'],
        ['international', 'internat'],
        // y: initial and after a vowel it is a consonant (Y), restored afterwards; final y after a consonant → i
        ['youth', 'youth'],
        ['saying', 'say'],
        ['happy', 'happi'],
        ['cry', 'cri'],
        ['by', 'by'],
        // Step 1a
        ['caresses', 'caress'],
        ['ties', 'tie'],
        ['cries', 'cri'],
        ['gas', 'gas'],
        ['gaps', 'gap'],
        ['kiwis', 'kiwi'],
        ["wren's", 'wren'],
        // Step 1b, the -ing exceptions and the e restored
        ['dying', 'die'],
        ['lying', 'lie'],
        ['inning', 'inning'],
        ['outing', 'outing'],
        ['canning', 'canning'],
        ['proceed', 'proceed'],
        ['agreed', 'agre'],
        ['hoped', 'hope'],
        ['hopping', 'hop'],
        ['luxuriating', 'luxuri'],
        // Steps 2 to 5
        ['relational', 'relat'],
        ['conditional', 'condit'],
        ['geology', 'geolog'],
        ['ecologist', 'ecolog'],
        ['hopefulness', 'hope'],
        ['effective', 'effect'],
        ['controll', 'control'],
        ['running', 'run'],
        ['runs', 'run'],
    ])('%s → %s', (word, stem) => {
        expect(porter2Stem(word)).toBe(stem);
    });
});

it('never changes more than the last two characters of a stem it keeps (what the ranking skips a source by)', () => {
    // The needle of a stem — all but its last two characters — begins every word with that stem.
    const broken = voc.filter((w) => !w.replace(/^'+/, '').startsWith(stemNeedle(porter2Stem(w)).replace(/^'+/, '')));
    expect(broken).toEqual([]);
});
