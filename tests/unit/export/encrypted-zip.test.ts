/**
 * The full export's archive is WinZip AES (AE-2, AES-256), NEVER ZipCrypto (Phase 5.H-a, D36), and readable by any
 * AES zip tool: proved against an INDEPENDENT implementation of the specification (`tests/helpers/ae2-zip.ts`, over
 * `node:crypto` alone), in both directions, and against the library's own reader.
 */
import { createHash } from 'node:crypto';
import { BlobReader, TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import { createEncryptedZip } from '@/lib/export/encrypted-zip';
import { ae2Keys, readAe2Zip, readCentralDirectory, winzipCtr, writeAe2Zip } from '../../helpers/ae2-zip';

const PASSPHRASE = 'correct horse battery staple';

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

async function archive(files: Array<[string, string | Uint8Array | ReadableStream<Uint8Array>]>, passphrase = PASSPHRASE): Promise<Buffer> {
    const zip = createEncryptedZip(passphrase);
    const bytes = collect(zip.readable);
    for (const [name, content] of files) {
        if (typeof content === 'string') await zip.addText(name, content);
        else if (content instanceof Uint8Array) await zip.addBytes(name, content, { store: true });
        else await zip.addStream(name, content);
    }
    await zip.close();
    return bytes;
}

describe('the independent reader is right (known answers)', () => {
    it('PBKDF2-HMAC-SHA1 meets RFC 6070’s vector', () => {
        // RFC 6070, test 2: P = "password", S = "salt", c = 2, dkLen = 20. ae2Keys fixes c = 1000, so the KDF it calls
        // is checked through node:crypto at the RFC's own parameters, then ae2Keys against itself at AE-2's.
        const { pbkdf2Sync } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
        expect(pbkdf2Sync('password', 'salt', 2, 20, 'sha1').toString('hex')).toBe('ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957');
        const k = ae2Keys('password', Buffer.from('salt'));
        expect(Buffer.concat([k.aesKey, k.macKey, k.verifier]).toString('hex')).toBe(pbkdf2Sync('password', 'salt', 1000, 66, 'sha1').toString('hex'));
    });

    it('CTR counts little-endian from 1 (the AES-256 FIPS-197 key, block 1 = ECB of 01 00 … 00)', () => {
        const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
        const zeros = Buffer.alloc(32);
        const stream = winzipCtr(key, zeros);
        const { createCipheriv } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
        const ecb = createCipheriv('aes-256-ecb', key, null);
        ecb.setAutoPadding(false);
        const one = Buffer.alloc(16);
        one[0] = 1;
        const two = Buffer.alloc(16);
        two[0] = 2;
        expect(stream.toString('hex')).toBe(Buffer.concat([ecb.update(one), ecb.update(two)]).toString('hex'));
        // Round trip: the same function decrypts.
        expect(winzipCtr(key, stream).equals(zeros)).toBe(true);
    });
});

describe('createEncryptedZip', () => {
    it('writes every entry as AE-2, AES-256, method 99 — never ZipCrypto', async () => {
        const zip = await archive([
            ['README.md', '# hello\n'],
            ['books/001-a/manuscript.md', 'She ran for the boats.\n'.repeat(200)],
            ['books/001-a/bible-bundle.zip', new Uint8Array([1, 2, 3, 4])],
        ]);
        const entries = readCentralDirectory(zip);
        expect(entries.map((e) => e.name)).toEqual(['README.md', 'books/001-a/manuscript.md', 'books/001-a/bible-bundle.zip']);
        for (const e of entries) {
            expect(e.flags & 1).toBe(1); // encrypted
            expect(e.method).toBe(99); // WinZip AES, never 8/0 with the ZipCrypto header
            expect(e.aes).toEqual(expect.objectContaining({ vendorVersion: 2, vendorId: 'AE', strength: 3 }));
            expect(e.crc).toBe(0); // AE-2 stores no CRC (it would leak a checksum of the plaintext)
        }
        // Every local header says the same (a reader may trust either).
        for (const e of entries) {
            expect(zip.readUInt32LE(e.localOffset)).toBe(0x04034b50);
            expect(zip.readUInt16LE(e.localOffset + 8)).toBe(99);
        }
    });

    it('decrypts with the independent AE-2 reader, authenticated, and refuses a wrong passphrase', async () => {
        const body = 'Wren never learned to swim.\n'.repeat(500);
        const zip = await archive([['notes.txt', body], ['raw.bin', new Uint8Array([0, 255, 7])]]);
        const files = readAe2Zip(zip, PASSPHRASE);
        expect(files.get('notes.txt')!.toString('utf8')).toBe(body);
        expect([...files.get('raw.bin')!]).toEqual([0, 255, 7]);
        expect(() => readAe2Zip(zip, 'the wrong passphrase!')).toThrow(/wrong password|authentication/);
        // Tampering with the ciphertext fails the authentication code.
        const tampered = Buffer.from(zip);
        const e = readCentralDirectory(zip)[0];
        tampered[e.localOffset + 30 + Buffer.byteLength('notes.txt') + 11 + 20] ^= 0xff;
        expect(() => readAe2Zip(tampered, PASSPHRASE)).toThrow(/authentication/);
    });

    it('the plaintext appears nowhere in the archive', async () => {
        const secret = 'The harbourmaster is Wren’s father.';
        const zip = await archive([['manuscript.md', secret.repeat(50)]]);
        expect(zip.includes(Buffer.from('harbourmaster'))).toBe(false);
    });

    it('streams an entry whose content arrives in pieces', async () => {
        const enc = new TextEncoder();
        const lines = Array.from({ length: 300 }, (_, i) => `{"n":${i}}\n`);
        let i = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(c) {
                if (i >= lines.length) return c.close();
                c.enqueue(enc.encode(lines.slice(i, i + 50).join('')));
                i += 50;
            },
        });
        const zip = await archive([['rows.jsonl', stream]]);
        expect(readAe2Zip(zip, PASSPHRASE).get('rows.jsonl')!.toString('utf8')).toBe(lines.join(''));
    });

    it('is read by the library’s own reader, and the library reads an archive the specification’s writer made', async () => {
        const zip = await archive([['a.txt', 'alpha'], ['b/c.txt', 'gamma']]);
        const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(zip)), { password: PASSPHRASE });
        const got = await Promise.all((await reader.getEntries()).map(async (e) => [e.filename, e.directory ? '' : await e.getData(new TextWriter())]));
        expect(got).toEqual([['a.txt', 'alpha'], ['b/c.txt', 'gamma']]);
        await reader.close();

        const ours = writeAe2Zip(new Map([['x.txt', Buffer.from('written from the spec')]]), PASSPHRASE);
        const back = new ZipReader(new BlobReader(new Blob([new Uint8Array(ours)])), { password: PASSPHRASE });
        const [entry] = await back.getEntries();
        expect(entry.directory ? null : await entry.getData(new TextWriter())).toBe('written from the spec');
        await back.close();
        expect(createHash('sha256').update(ours).digest('hex')).toHaveLength(64);
    });

    it('a cancelled download stops the writer (every later add refuses)', async () => {
        const zip = createEncryptedZip(PASSPHRASE);
        await zip.readable.cancel();
        await expect(zip.addText('a.txt', 'x'.repeat(100_000))).rejects.toThrow();
    });
});
