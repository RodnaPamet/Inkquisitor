/**
 * The zip module (src/lib/archive/zip.ts, Phase 1.3): `writeZip` is a
 * function of its files alone — in any timezone, at any time — and `readZip`
 * refuses, by name and before it allocates, everything a hostile archive can
 * try: a bomb (by count, size, total and ratio, and by lying about its size),
 * an unsafe or duplicate name, encryption, an unknown method, ZIP64, and
 * corruption.
 */
import { deflateRawSync } from 'node:zlib';
import { fixedZipTime, isSafeEntryName, readZip, writeZip, ZipRefusal, type ZipLimits } from '@/lib/archive/zip';
import { craftZip, type CraftedEntry } from '../../helpers/zip-craft';

const LIMITS: ZipLimits = { maxEntries: 20, maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 6 * 1024 * 1024, maxRatio: 100 };

function refusal(bytes: Uint8Array, limits: ZipLimits = LIMITS): { reason: string; entry?: string } {
    try {
        readZip(bytes, limits);
    } catch (err) {
        if (err instanceof ZipRefusal) return { reason: err.reason, entry: err.entry };
        throw err;
    }
    throw new Error('the archive was accepted');
}

const files = () =>
    new Map<string, string>([
        ['manifest.json', '{"format":"x"}\n'],
        ['character/mara.md', '---\nname: Mara\n---\n'],
        ['book.md', '# Book\n'],
    ]);

describe('writeZip', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
        process.env.TZ = originalTz;
    });

    it('is byte-identical for the same files, whatever order they arrive in', () => {
        const a = writeZip(files());
        const b = writeZip(new Map([...files()].reverse()));
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });

    it('carries no wall-clock time: the same bytes in two far-apart timezones, every entry dated 2000-01-01 00:00', () => {
        process.env.TZ = 'Pacific/Kiritimati';
        const east = writeZip(files());
        process.env.TZ = 'America/Los_Angeles';
        const west = writeZip(files());
        expect(Buffer.from(east).equals(Buffer.from(west))).toBe(true);
        const buf = Buffer.from(west);
        expect(buf.readUInt16LE(10)).toBe(0); // DOS time of the first local header
        expect(buf.readUInt16LE(12)).toBe(((2000 - 1980) << 9) | (1 << 5) | 1); // DOS date
        expect(fixedZipTime().getFullYear()).toBe(2000);
    });

    it('writes entries in name order, and readZip reads every one back exactly', () => {
        const zip = writeZip(files());
        const back = readZip(zip, LIMITS);
        expect([...back.keys()]).toEqual(['book.md', 'character/mara.md', 'manifest.json']);
        for (const [name, content] of files()) expect(new TextDecoder().decode(back.get(name)!)).toBe(content);
    });
});

describe('readZip refuses', () => {
    it('what is not a zip', () => {
        expect(refusal(new TextEncoder().encode('not a zip at all, just some text that is long enough'))).toEqual({ reason: 'NOT_A_ZIP', entry: undefined });
        expect(refusal(new Uint8Array(4))).toMatchObject({ reason: 'NOT_A_ZIP' });
    });

    it('more entries than the limit, on the directory’s own count, before reading one', () => {
        const entries: CraftedEntry[] = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.md`, data: 'x' }));
        expect(refusal(craftZip(entries))).toMatchObject({ reason: 'TOO_MANY_ENTRIES' });
        expect(refusal(craftZip([{ name: 'a.md', data: 'x' }], { entryCountOverride: 0xffff }))).toMatchObject({ reason: 'ZIP64_UNSUPPORTED' });
    });

    it.each([['../escape.md'], ['/etc/passwd'], ['a\\b.md'], ['C:x.md'], ['a/./b.md'], ['a//b.md'], ['a/../b.md'], ['tab\there.md']])('an unsafe name: %s', (name) => {
        expect(refusal(craftZip([{ name, data: 'x' }]))).toMatchObject({ reason: 'ENTRY_NAME_UNSAFE' });
    });

    it('two entries of one name', () => {
        expect(refusal(craftZip([{ name: 'a.md', data: 'x' }, { name: 'a.md', data: 'y' }]))).toEqual({ reason: 'ENTRY_DUPLICATE', entry: 'a.md' });
    });

    it('an encrypted entry and an unknown method', () => {
        expect(refusal(craftZip([{ name: 'a.md', data: 'x', flags: 0x0801 }]))).toMatchObject({ reason: 'ENTRY_ENCRYPTED' });
        expect(refusal(craftZip([{ name: 'a.md', data: 'x', method: 12 }]))).toMatchObject({ reason: 'ENTRY_METHOD_UNSUPPORTED' });
    });

    it('an entry, or the whole archive, declaring more than its bound', () => {
        expect(refusal(craftZip([{ name: 'a.md', data: 'x', size: LIMITS.maxEntryBytes + 1 }]))).toMatchObject({ reason: 'ENTRY_TOO_LARGE' });
        const big = 'y'.repeat(3 * 1024 * 1024);
        expect(refusal(craftZip([{ name: 'a.md', data: big, method: 0 }, { name: 'b.md', data: big, method: 0 }, { name: 'c.md', data: 'z', method: 0 }]))).toMatchObject({
            reason: 'ARCHIVE_TOO_LARGE',
        });
    });

    it('an entry that compresses past the ratio (a zip bomb by its own declaration)', () => {
        const zeros = new Uint8Array(1024 * 1024);
        expect(refusal(craftZip([{ name: 'bomb.md', data: zeros }]))).toEqual({ reason: 'ENTRY_RATIO', entry: 'bomb.md' });
        // Below the exempt size, a high ratio is allowed: the total bounds it.
        expect(readZip(craftZip([{ name: 'small.md', data: new Uint8Array(32 * 1024) }]), LIMITS).get('small.md')).toHaveLength(32 * 1024);
    });

    it('an entry that lies about its size: inflation stops at the claim, and the entry is refused', () => {
        // 64 MiB of zeros, declared as 100 bytes. Inflating it in full would
        // pass every declared bound; the reader stops at 100 bytes.
        const bomb = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
        const archive = craftZip([{ name: 'liar.md', body: bomb, size: 100, crc: 0 }]);
        const started = Date.now();
        expect(refusal(archive)).toEqual({ reason: 'ENTRY_CORRUPT', entry: 'liar.md' });
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('a CRC mismatch, a stored entry whose sizes disagree, and a local header naming another file', () => {
        expect(refusal(craftZip([{ name: 'a.md', data: 'hello', crc: 1 }]))).toMatchObject({ reason: 'ENTRY_CORRUPT' });
        expect(refusal(craftZip([{ name: 'a.md', data: 'hello', method: 0, size: 4 }]))).toMatchObject({ reason: 'ENTRY_CORRUPT' });
        expect(refusal(craftZip([{ name: 'a.md', data: 'hello', localName: 'b.md' }]))).toMatchObject({ reason: 'ENTRY_CORRUPT' });
    });

    it('skips directory entries and accepts a stored entry', () => {
        const back = readZip(craftZip([{ name: 'character/', data: '', method: 0 }, { name: 'character/a.md', data: 'hi', method: 0 }]), LIMITS);
        expect([...back.keys()]).toEqual(['character/a.md']);
    });
});

describe('isSafeEntryName', () => {
    it('accepts bundle paths and refuses escapes', () => {
        expect(isSafeEntryName('timeline_event/the-flood.md')).toBe(true);
        expect(isSafeEntryName('character/')).toBe(true);
        expect(isSafeEntryName('..')).toBe(false);
        expect(isSafeEntryName('')).toBe(false);
        expect(isSafeEntryName('a'.repeat(256))).toBe(false);
    });
});
