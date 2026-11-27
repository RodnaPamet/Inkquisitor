/**
 * An INDEPENDENT WinZip AES (AE-2) reader and writer, over `node:crypto` and `node:zlib` alone (Phase 5.H-a, D36).
 *
 * The full export is written by `@zip.js/zip.js`. Proving the archive with that library's own reader would prove only
 * that the library agrees with itself; this helper implements the published specification
 * (https://www.winzip.com/en/support/aes-encryption/) from scratch, so the tests hold the archive to the format every
 * other AES zip tool reads:
 *
 *   - an entry is method 99 with the 0x9901 extra field: vendor version 2 (AE-2: the CRC is not stored, 0), vendor id
 *     "AE", strength 3 (AES-256), the actual compression method;
 *   - its data is a 16-byte salt, a 2-byte password verifier, the AES-CTR ciphertext and a 10-byte authentication code;
 *   - the keys are PBKDF2-HMAC-SHA1(password, salt, 1,000 iterations, 66 bytes): 32 for AES, 32 for HMAC-SHA1, 2 for
 *     the verifier;
 *   - CTR's counter is a 16-byte LITTLE-ENDIAN integer starting at 1 (not the big-endian counter of `aes-256-ctr`),
 *     so each block's key stream is AES-256-ECB of the counter block;
 *   - the code is the first 10 bytes of HMAC-SHA1 over the ciphertext.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface Ae2Entry {
    name: string;
    flags: number;
    method: number;
    crc: number;
    /** The 0x9901 extra field, read: vendor version, vendor id, strength, actual method. */
    aes: { vendorVersion: number; vendorId: string; strength: number; actualMethod: number } | null;
    compressedSize: number;
    localOffset: number;
}

/** PBKDF2-HMAC-SHA1 as AE-2 uses it: the AES key, the HMAC key and the verifier. */
export function ae2Keys(password: string, salt: Buffer): { aesKey: Buffer; macKey: Buffer; verifier: Buffer } {
    const dk = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 1000, 66, 'sha1');
    return { aesKey: dk.subarray(0, 32), macKey: dk.subarray(32, 64), verifier: dk.subarray(64, 66) };
}

/** AES-256 in WinZip's CTR mode (little-endian counter from 1): the same function encrypts and decrypts. */
export function winzipCtr(key: Buffer, data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    const ecb = createCipheriv('aes-256-ecb', key, null);
    ecb.setAutoPadding(false);
    const counter = Buffer.alloc(16);
    for (let offset = 0, block = 1; offset < data.length; offset += 16, block++) {
        counter.fill(0);
        // A little-endian 128-bit block number (an export never passes 2^53 blocks).
        let n = block;
        for (let i = 0; i < 8 && n > 0; i++) {
            counter[i] = n % 256;
            n = Math.floor(n / 256);
        }
        const stream = ecb.update(counter);
        for (let i = 0; i < 16 && offset + i < data.length; i++) out[offset + i] = data[offset + i] ^ stream[i];
    }
    return out;
}

/** The archive's central directory, read (no ZIP64: the test archives are small). */
export function readCentralDirectory(zip: Buffer): Ae2Entry[] {
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('no end of central directory');
    const count = zip.readUInt16LE(eocd + 10);
    let at = zip.readUInt32LE(eocd + 16);
    const entries: Ae2Entry[] = [];
    for (let n = 0; n < count; n++) {
        if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
        const flags = zip.readUInt16LE(at + 8);
        const method = zip.readUInt16LE(at + 10);
        const crc = zip.readUInt32LE(at + 16);
        const compressedSize = zip.readUInt32LE(at + 20);
        const nameLen = zip.readUInt16LE(at + 28);
        const extraLen = zip.readUInt16LE(at + 30);
        const commentLen = zip.readUInt16LE(at + 32);
        const localOffset = zip.readUInt32LE(at + 42);
        const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
        const extra = zip.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
        entries.push({ name, flags, method, crc, aes: aesExtra(extra), compressedSize, localOffset });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function aesExtra(extra: Buffer): Ae2Entry['aes'] {
    for (let i = 0; i + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(i);
        const size = extra.readUInt16LE(i + 2);
        if (id === 0x9901 && size >= 7) {
            return { vendorVersion: extra.readUInt16LE(i + 4), vendorId: extra.subarray(i + 6, i + 8).toString('latin1'), strength: extra[i + 8], actualMethod: extra.readUInt16LE(i + 9) };
        }
        i += 4 + size;
    }
    return null;
}

/** One entry's plaintext, decrypted and authenticated per AE-2; throws on a wrong password or a failed code. */
export function decryptAe2Entry(zip: Buffer, entry: Ae2Entry, password: string): Buffer {
    if (entry.method !== 99 || !entry.aes) throw new Error(`${entry.name}: not a WinZip AES entry`);
    const nameLen = zip.readUInt16LE(entry.localOffset + 26);
    const extraLen = zip.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const data = zip.subarray(start, start + entry.compressedSize);
    const saltLen = { 1: 8, 2: 12, 3: 16 }[entry.aes.strength as 1 | 2 | 3];
    const salt = data.subarray(0, saltLen);
    const verifier = data.subarray(saltLen, saltLen + 2);
    const cipher = data.subarray(saltLen + 2, data.length - 10);
    const code = data.subarray(data.length - 10);
    const keys = ae2Keys(password, Buffer.from(salt));
    if (!timingSafeEqual(keys.verifier, verifier)) throw new Error(`${entry.name}: wrong password`);
    const mac = createHmac('sha1', keys.macKey).update(cipher).digest().subarray(0, 10);
    if (!timingSafeEqual(mac, code)) throw new Error(`${entry.name}: authentication code failed`);
    const compressed = winzipCtr(keys.aesKey, Buffer.from(cipher));
    return entry.aes.actualMethod === 8 ? inflateRawSync(compressed) : compressed;
}

/** Every entry of an AE-2 archive, decrypted, by name. */
export function readAe2Zip(zip: Buffer, password: string): Map<string, Buffer> {
    return new Map(readCentralDirectory(zip).map((e) => [e.name, decryptAe2Entry(zip, e, password)] as const));
}

/** A minimal AE-2 archive written from the specification (one deflated entry a file): the other direction's proof. */
export function writeAe2Zip(files: ReadonlyMap<string, Buffer>, password: string): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const salt = randomBytes(16);
        const keys = ae2Keys(password, salt);
        const cipher = winzipCtr(keys.aesKey, deflateRawSync(content));
        const code = createHmac('sha1', keys.macKey).update(cipher).digest().subarray(0, 10);
        const data = Buffer.concat([salt, keys.verifier, cipher, code]);
        const extra = Buffer.alloc(11);
        extra.writeUInt16LE(0x9901, 0);
        extra.writeUInt16LE(7, 2);
        extra.writeUInt16LE(2, 4);
        extra.write('AE', 6, 'latin1');
        extra[8] = 3;
        extra.writeUInt16LE(8, 9);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(51, 4);
        local.writeUInt16LE(0x0801, 6); // encrypted, UTF-8 names
        local.writeUInt16LE(99, 8);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(extra.length, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(51, 4);
        central.writeUInt16LE(51, 6);
        central.writeUInt16LE(0x0801, 8);
        central.writeUInt16LE(99, 10);
        central.writeUInt32LE(0, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(extra.length, 30);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, extra, data);
        centrals.push(central, nameBytes, extra);
        offset += local.length + nameBytes.length + extra.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.size, 8);
    eocd.writeUInt16LE(files.size, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
