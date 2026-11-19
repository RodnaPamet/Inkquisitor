/**
 * The encryption extension's traversal, against a TEST manifest and a TEST
 * model graph (the shipped manifest is empty until Phase 1): which fields of
 * a write payload are sealed, which of a result are opened, and what happens
 * on a read that cannot be.
 *
 * The graph mirrors what Prisma's DMMF says about relations: a Book has many
 * BibleEntry rows and many Character rows; BibleEntry.value is in the manifest
 * and Character.value — the same field NAME on another model — is not.
 */
import { randomBytes } from 'node:crypto';
import { _internals, buildModelGraph, EncryptionKeyUnavailableError, withEncryptionExtension } from '@/lib/db/encryption-middleware';
import { compileManifest, ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { decryptField, decryptWithKey, encryptField, encryptWithKey, isEncryptedValue } from '@/lib/security/encryption';
import type { WorkspaceKeyManager } from '@/lib/security/workspace-key-manager';

const m = compileManifest({ BibleEntry: ['value', 'summary'] });
const graph = buildModelGraph([
    {
        name: 'Book',
        fields: [
            { name: 'title', kind: 'scalar', type: 'String' },
            { name: 'entries', kind: 'object', type: 'BibleEntry' },
            { name: 'characters', kind: 'object', type: 'Character' },
        ],
    },
    {
        name: 'BibleEntry',
        fields: [
            { name: 'value', kind: 'scalar', type: 'String' },
            { name: 'summary', kind: 'scalar', type: 'String' },
            { name: 'title', kind: 'scalar', type: 'String' },
            { name: 'book', kind: 'object', type: 'Book' },
        ],
    },
    {
        name: 'Character',
        fields: [
            { name: 'value', kind: 'scalar', type: 'String' },
            { name: 'summary', kind: 'scalar', type: 'String' },
            { name: 'book', kind: 'object', type: 'Book' },
        ],
    },
]);
const dek = randomBytes(32);
const seal = (payload: unknown, model: string, key: Buffer | null = dek) => _internals.sealData(payload, model, key, m, graph) as Record<string, unknown>;
const resolved = { primary: dek, previous: null, reason: 'resolved' as const };

describe('writes', () => {
    it('seals exactly the manifest fields of the model, under the workspace key', () => {
        const data = seal({ value: 'She is afraid of the sea.', summary: 'Fear', title: 'Mara' }, 'BibleEntry');
        expect(isEncryptedValue(data.value)).toBe(true);
        expect(decryptWithKey(dek, data.value as string)).toBe('She is afraid of the sea.');
        expect(isEncryptedValue(data.summary)).toBe(true);
        expect(data.title).toBe('Mara');
    });

    it('seals a plaintext that merely LOOKS like an envelope — a prefix is not proof of encryption', () => {
        for (const text of ['v2: rewrite the opening chapter', 'v1: first draft notes', encryptWithKey(dek, 'a real envelope, pasted')]) {
            const data = seal({ value: text }, 'BibleEntry');
            expect(data.value).not.toBe(text);
            expect(decryptWithKey(dek, data.value as string)).toBe(text);
        }
    });

    it("never mutates the caller's payload, so a retry seals the plaintext again rather than a ciphertext", () => {
        const payload = { value: 'retry me', entries: undefined };
        const first = seal(payload, 'BibleEntry');
        expect(payload.value).toBe('retry me');
        const second = seal(payload, 'BibleEntry');
        expect(decryptWithKey(dek, first.value as string)).toBe('retry me');
        expect(decryptWithKey(dek, second.value as string)).toBe('retry me');
    });

    it('seals a `{ set }` scalar update too', () => {
        const data = seal({ value: { set: 'set operation' } }, 'BibleEntry');
        expect(decryptWithKey(dek, (data.value as { set: string }).set)).toBe('set operation');
    });

    it('reaches nested writes through the RELATED model, and leaves empty values alone', () => {
        const data = seal(
            {
                title: 'x',
                entries: {
                    create: [{ value: 'nested secret', summary: '' }],
                    createMany: { data: [{ value: 'many' }] },
                    connectOrCreate: { where: { id: 'e1' }, create: { value: 'connect-or-create' } },
                    update: [{ where: { id: 'e2' }, data: { value: 'to-many update' } }],
                    updateMany: { where: {}, data: { summary: 'update many' } },
                    upsert: { where: { id: 'e3' }, create: { value: 'upsert create' }, update: { value: 'upsert update' } },
                },
            },
            'Book',
        );
        const e = data.entries as Record<string, Record<string, unknown> & Array<Record<string, unknown>>>;
        const open = (v: unknown) => decryptWithKey(dek, v as string);
        expect(open(e.create[0].value)).toBe('nested secret');
        expect(e.create[0].summary).toBe('');
        expect(open((e.createMany.data as unknown as Array<Record<string, unknown>>)[0].value)).toBe('many');
        expect(open((e.connectOrCreate.create as Record<string, unknown>).value)).toBe('connect-or-create');
        expect(open((e.update[0].data as Record<string, unknown>).value)).toBe('to-many update');
        expect(open((e.updateMany.data as Record<string, unknown>).summary)).toBe('update many');
        expect(open((e.upsert.create as Record<string, unknown>).value)).toBe('upsert create');
        expect(open((e.upsert.update as Record<string, unknown>).value)).toBe('upsert update');
        expect(data.title).toBe('x');
    });

    it("leaves a same-named field of ANOTHER model alone, top level and nested", () => {
        expect(seal({ value: 'not secret', summary: 'not secret either' }, 'Character')).toEqual({ value: 'not secret', summary: 'not secret either' });
        const nested = seal({ title: 'x', characters: { create: { value: 'a character' } }, entries: { create: { value: 'an entry' } } }, 'Book');
        expect((nested.characters as { create: { value: string } }).create.value).toBe('a character');
        expect(isEncryptedValue((nested.entries as { create: { value: string } }).create.value)).toBe(true);
        // and back up the other way: Character → Book → entries.
        const up = seal({ value: 'plain', book: { create: { title: 't', entries: { create: { value: 'deep' } } } } }, 'Character');
        expect(up.value).toBe('plain');
        const deep = (up.book as { create: { entries: { create: { value: string } } } }).create.entries.create.value;
        expect(decryptWithKey(dek, deep)).toBe('deep');
    });

    it('an unknown model encrypts nothing', () => {
        expect(seal({ value: 'x', summary: 'y' }, 'NotAModel')).toEqual({ value: 'x', summary: 'y' });
    });

    it('without a workspace key, seals under the master key (v1), never leaves plaintext', () => {
        const data = seal({ value: 'no workspace in context' }, 'BibleEntry', null);
        expect(String(data.value)).toMatch(/^v1:/);
        expect(decryptField(data.value as string)).toBe('no workspace in context');
    });
});

describe('reads', () => {
    const read = (row: unknown, model: string, deks: Parameters<typeof _internals.walkRead>[2] = resolved) => _internals.walkRead(row, model, deks, m, graph);

    it('opens manifest fields with the workspace key', () => {
        const row = { value: encryptWithKey(dek, 'opened'), title: 'kept' };
        read(row, 'BibleEntry');
        expect(row).toEqual({ value: 'opened', title: 'kept' });
    });

    it('opens nested rows by their RELATED model, and never a same-named field of another model', () => {
        const lookalike = encryptField('a character value that happens to be an envelope');
        const row = { title: 't', entries: [{ value: encryptWithKey(dek, 'entry') }], characters: [{ value: lookalike }] };
        read(row, 'Book');
        expect(row.entries[0].value).toBe('entry');
        expect(row.characters[0].value).toBe(lookalike);
        const character = { value: lookalike };
        read(character, 'Character');
        expect(character.value).toBe(lookalike);
        const unknown = { value: lookalike };
        read(unknown, 'NotAModel');
        expect(unknown.value).toBe(lookalike);
    });

    it('a v2 value with no workspace in context reads as null, never as ciphertext', () => {
        const row: Record<string, unknown> = { value: encryptWithKey(dek, 'hidden') };
        read(row, 'BibleEntry', { primary: null, previous: null, reason: 'no-workspace' });
        expect(row.value).toBeNull();
    });

    it('a v2 value whose key could not be resolved throws, rather than hand a ciphertext on to be re-saved', () => {
        const row: Record<string, unknown> = { value: encryptWithKey(dek, 'hidden') };
        expect(() => read(row, 'BibleEntry', { primary: null, previous: null, reason: 'resolve-failed' })).toThrow(EncryptionKeyUnavailableError);
    });

    it('a value the key in hand cannot open throws, loudly', () => {
        const row = { value: encryptWithKey(randomBytes(32), 'other workspace') };
        expect(() => read(row, 'BibleEntry')).toThrow(/failed to decrypt/);
    });
});

describe('wiring', () => {
    it('the shipped manifest is empty, and an empty manifest adds no extension at all', () => {
        expect(ENCRYPTED_FIELDS).toEqual({});
        const client = { $extends: jest.fn() };
        const keys = {} as WorkspaceKeyManager;
        expect(withEncryptionExtension(client, { keys })).toBe(client);
        expect(client.$extends).not.toHaveBeenCalled();
        withEncryptionExtension(client, { keys, manifest: { BibleEntry: ['value'] }, graph });
        expect(client.$extends).toHaveBeenCalledTimes(1);
    });

    it('the model graph is read from the schema by default: User reaches WorkspaceMembership and back', () => {
        const real = buildModelGraph();
        expect(real.relatedModel('User', 'memberships')).toBe('WorkspaceMembership');
        expect(real.relatedModel('WorkspaceMembership', 'workspace')).toBe('Workspace');
        expect(real.relatedModel('User', 'name')).toBeUndefined();
        expect(real.hasModel('NotAModel')).toBe(false);
    });
});
