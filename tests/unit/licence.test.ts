/**
 * The licence files say what owner decision D2 (docs/ROADMAP.md section 2)
 * decided: BUSL-1.1, licensor Inflect Ltd., mirroring inflect-compliance.
 *
 * The BUSL text outside the Parameters block may not be modified (its
 * Covenant 4). The header and everything from the Terms onward are pinned by
 * SHA-256 to the bytes of inflect-compliance's LICENSE at the carve commit,
 * so an edit to them fails here rather than in a lawyer's reading.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const RULE = '-----------------------------------------------------------------------------\n';

/** sha256 of inflect-compliance's LICENSE, same two slices, at 5528464. */
const INFLECT_HEADER_SHA256 = '5dd23568f818e812268e5964411fc68f40fb05317b142459665109bd3017cea2';
const INFLECT_TERMS_SHA256 = '106c5cb42a41320a71852640e73062877b0a49a76b98e65e647637e78c18437f';

describe('LICENSE', () => {
    const licence = read('LICENSE');
    const paramsAt = licence.indexOf('Parameters\n');
    const termsAt = licence.indexOf(`${RULE}\nTerms`);
    const params = licence.slice(paramsAt, termsAt);
    const field = (name: string) => {
        const m = new RegExp(`^${name}:\\s+([\\s\\S]*?)(?=\\n\\n)`, 'm').exec(params);
        if (!m) throw new Error(`LICENSE: no "${name}:" parameter`);
        return m[1].replace(/\s+/g, ' ').trim();
    };

    it('has a Parameters block before the Terms', () => {
        expect(paramsAt).toBeGreaterThan(0);
        expect(termsAt).toBeGreaterThan(paramsAt);
    });

    it('keeps the BUSL 1.1 header and Terms byte-for-byte', () => {
        expect(sha256(licence.slice(0, paramsAt))).toBe(INFLECT_HEADER_SHA256);
        expect(sha256(licence.slice(termsAt))).toBe(INFLECT_TERMS_SHA256);
    });

    it('names Inflect Ltd. as Licensor', () => {
        expect(field('Licensor')).toBe('Inflect Ltd., a company registered in Bulgaria.');
    });

    it('names Inkquisitor as the Licensed Work', () => {
        expect(field('Licensed Work')).toBe(
            'Inkquisitor, as made available in this repository (github.com/RodnaPamet/Inkquisitor) and in each version released by the Licensor. The Licensed Work is © 2026 Inflect Ltd.',
        );
    });

    it('grants production use except a competing hosted writing product', () => {
        const grant = field('Additional Use Grant');
        expect(grant).toMatch(/^You may make production use of the Licensed Work, provided that/);
        expect(grant).toContain(
            'including any book-development, manuscript, story-planning, writing-assistant, or author-interview product or service',
        );
        expect(grant).toContain('that competes with any product or service offered by the Licensor.');
        expect(grant).toContain(
            "Using the Licensed Work for your own writing, or for your own organization's internal editorial work, is permitted.",
        );
        expect(grant).not.toMatch(/compliance/i);
    });

    it('changes to Apache-2.0 on 2030-11-18, per version', () => {
        expect(field('Change Date')).toMatch(/^2030-11-18 \(four years after the initial version's first public availability;/);
        expect(field('Change Date')).toContain('determined separately for each version');
        expect(field('Change License')).toBe('Apache License, Version 2.0');
    });

    it('keeps the alternative-licensing contact', () => {
        expect(params).toContain(
            'For information about alternative licensing arrangements for the Licensed\nWork, please contact ivo@inflect.bg.',
        );
    });
});

describe('package.json licence and engines', () => {
    const pkg = JSON.parse(read('package.json'));

    it('declares BUSL-1.1 and stays private', () => {
        expect(pkg.name).toBe('inkquisitor');
        expect(pkg.license).toBe('BUSL-1.1');
        expect(pkg.private).toBe(true);
    });

    it('runs on Node 24 only, matching .nvmrc', () => {
        expect(pkg.engines.node).toBe('>=24.0.0 <25.0.0');
        expect(read('.nvmrc').trim()).toBe('24');
    });
});

describe('LICENSING.md and NOTICE', () => {
    it('LICENSING.md defers to LICENSE and records the relicensing of inflect-compliance code', () => {
        const doc = read('LICENSING.md');
        expect(doc).toContain('BUSL-1.1');
        expect(doc).toMatch(/inflect-compliance/);
        expect(doc).toMatch(/same licensor/i);
        expect(doc).toContain('NOTICE');
    });

    it('NOTICE records the carve commit', () => {
        const notice = read('NOTICE');
        expect(notice).toContain('Copyright © 2026 Inflect Ltd.');
        expect(notice).toContain('5528464fc54a8681956f3b9ce23ca9c075f0420e');
    });
});
