/**
 * Hand-built zip archives for the reader's refusal tests (Phase 1.3): each
 * entry's declared sizes, CRC, flags, method and name can lie, which a real
 * zip writer never lets them do.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface CraftedEntry {
    name: string;
    data?: Uint8Array | string;
    /** Store (0) or DEFLATE (8, default); any other number is written as given. */
    method?: number;
    flags?: number;
    /** Override what the directory declares. */
    size?: number;
    compressedSize?: number;
    crc?: number;
    /** Write a different name in the local header. */
    localName?: string;
    /** The entry's compressed bytes as given, in place of compressing `data`. */
    body?: Uint8Array;
    /** What the LOCAL header says, where it should differ from the directory (Phase 1.H). */
    local?: { method?: number; flags?: number; crc?: number; size?: number; compressedSize?: number };
}

export function craftZip(entries: readonly CraftedEntry[], options: { entryCountOverride?: number } = {}): Uint8Array {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data ?? new Uint8Array(0));
        const method = e.method ?? 8;
        const body = e.body ? Buffer.from(e.body) : method === 8 ? deflateRawSync(raw) : raw;
        const name = Buffer.from(e.name, 'utf8');
        const localName = Buffer.from(e.localName ?? e.name, 'utf8');
        const crc = e.crc ?? crc32(raw);
        const size = e.size ?? raw.length;
        const compressedSize = e.compressedSize ?? body.length;
        const flags = e.flags ?? 0x0800;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(e.local?.flags ?? flags, 6);
        local.writeUInt16LE(e.local?.method ?? method, 8);
        local.writeUInt32LE((e.local?.crc ?? crc) >>> 0, 14);
        local.writeUInt32LE((e.local?.compressedSize ?? compressedSize) >>> 0, 18);
        local.writeUInt32LE((e.local?.size ?? size) >>> 0, 22);
        local.writeUInt16LE(localName.length, 26);
        locals.push(local, localName, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc >>> 0, 16);
        central.writeUInt32LE(compressedSize >>> 0, 20);
        central.writeUInt32LE(size >>> 0, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + localName.length + body.length;
    }
    const directory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    const count = options.entryCountOverride ?? entries.length;
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}
