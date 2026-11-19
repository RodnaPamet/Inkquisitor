/**
 * Field encryption against a real database. This builds a client with a TEST
 * manifest
 * (`{ Workspace: ['name'] }`) — the extension takes the manifest as a
 * parameter for exactly this — and proves: a listed field is ciphertext at
 * rest, it reads back as plaintext in the workspace that wrote it, it is
 * refused under another workspace's key, a plaintext that merely looks like
 * an envelope is still encrypted, and a same-named field of a model the
 * manifest does not list (`User.name`) is never touched, at the top level or
 * nested.
 */
import { randomBytes } from 'node:crypto';
import { createDatabase, prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { runWithDbContext } from '@/lib/db/db-context';
import { DecryptIntegrityError } from '@/lib/db/encryption-middleware';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { encryptField } from '@/lib/security/encryption';
import { createAccount, createBareUser, uniqueEmail } from '../helpers/workspaces';

const db = createDatabase(process.env.DATABASE_URL, { manifest: { Workspace: ['name'] } });
// Two clients: the test one, and the singleton the fixtures write through.
afterAll(() => Promise.all([db.client.$disconnect(), prisma.$disconnect()]));

const SECRET_NAME = ['Mara', 'of', 'the', 'Salt', 'Roads'].join(' ');

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();
});

const ctxOf = (acc: typeof a) => ({ workspaceId: acc.workspaceId, userId: acc.userId, requestId: 'enc-test' });

async function rawWorkspaceName(id: string): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`SELECT "name" FROM "Workspace" WHERE "id" = ${id}`;
    return rows[0].name;
}
async function rawUserName(id: string): Promise<string | null> {
    const rows = await prisma.$queryRaw<Array<{ name: string | null }>>`SELECT "name" FROM "User" WHERE "id" = ${id}`;
    return rows[0]?.name ?? null;
}

function writeName(acc: typeof a, name: string) {
    return runInWorkspaceContext(ctxOf(acc), (tx) => tx.workspace.update({ where: { id: acc.workspaceId }, data: { name } }), { client: db.client });
}

it('the shipped manifest does not list the field this suite plays with (so the two clients disagree only where intended)', () => {
    expect(ENCRYPTED_FIELDS.Workspace).toBeUndefined();
    expect(ENCRYPTED_FIELDS.User).toBeUndefined();
});

it('a write inside a workspace is a v2 envelope at rest and reads back as plaintext there', async () => {
    const written = await writeName(a, SECRET_NAME);
    expect(written.name).toBe(SECRET_NAME);

    const atRest = await rawWorkspaceName(a.workspaceId);
    expect(atRest).toMatch(/^v2:/);
    expect(atRest).not.toContain('Mara');

    const read = await runInWorkspaceContext(ctxOf(a), (tx) => tx.workspace.findUnique({ where: { id: a.workspaceId } }), { client: db.client });
    expect(read?.name).toBe(SECRET_NAME);
});

it('a plaintext that starts like an envelope is encrypted, and reads back exactly', async () => {
    for (const text of ['v2: rewrite the opening chapter', 'v1: notes on the prologue']) {
        await writeName(a, text);
        const atRest = await rawWorkspaceName(a.workspaceId);
        expect(atRest).not.toBe(text);
        expect(atRest).toMatch(/^v2:/);
        expect(atRest).not.toContain('rewrite');
        const read = await runInWorkspaceContext(ctxOf(a), (tx) => tx.workspace.findUnique({ where: { id: a.workspaceId } }), { client: db.client });
        expect(read?.name).toBe(text);
    }
});

it('re-saving a value that was read back seals it again; a stored ciphertext offered as input is plaintext to the extension', async () => {
    await writeName(a, SECRET_NAME);
    const envelope = await rawWorkspaceName(a.workspaceId);
    await writeName(a, envelope);
    // The pasted envelope is stored as the author's text, under a fresh seal,
    // and reads back as the string that was written, not as its decryption.
    expect(await rawWorkspaceName(a.workspaceId)).not.toBe(envelope);
    const read = await runInWorkspaceContext(ctxOf(a), (tx) => tx.workspace.findUnique({ where: { id: a.workspaceId } }), { client: db.client });
    expect(read?.name).toBe(envelope);
});

it("another workspace's key refuses the ciphertext loudly; no workspace at all reads it as null", async () => {
    await writeName(a, SECRET_NAME);
    // B's key on A's row: RLS would hide the row from a B transaction, so the
    // key context is bound directly on the owning client.
    await expect(
        runWithDbContext({ workspaceId: b.workspaceId, source: 'test' }, () => db.client.workspace.findUnique({ where: { id: a.workspaceId } })),
    ).rejects.toBeInstanceOf(DecryptIntegrityError);
    const outside = await db.client.workspace.findUnique({ where: { id: a.workspaceId } });
    expect(outside?.name).toBeNull();
});

it('a write outside any workspace is sealed under the master key (v1), never plaintext', async () => {
    await db.client.workspace.update({ where: { id: b.workspaceId }, data: { name: SECRET_NAME } });
    expect(await rawWorkspaceName(b.workspaceId)).toMatch(/^v1:/);
    expect((await db.client.workspace.findUnique({ where: { id: b.workspaceId } }))?.name).toBe(SECRET_NAME);
});

describe('only the listed model is touched', () => {
    it('a top-level write and read of a same-named field on another model (User.name) pass through', async () => {
        const user = await createBareUser();
        await db.client.user.update({ where: { id: user.id }, data: { name: 'Plain Author' } });
        expect(await rawUserName(user.id)).toBe('Plain Author');

        // A User.name that happens to be a real envelope is not "decrypted".
        const lookalike = encryptField('not a manifest field');
        await prisma.user.update({ where: { id: user.id }, data: { name: lookalike } });
        expect((await db.client.user.findUnique({ where: { id: user.id } }))?.name).toBe(lookalike);
    });

    it('a nested write seals the related Workspace.name and leaves the User.name it sits beside alone', async () => {
        const slug = `nested-${randomBytes(4).toString('hex')}`;
        const created = await db.client.user.create({
            data: {
                email: uniqueEmail('nested'),
                name: 'Plain Author',
                memberships: { create: { role: 'OWNER', workspace: { create: { slug, name: 'Secret Desk' } } } },
            },
            include: { memberships: { include: { workspace: true } } },
        });
        expect(created.name).toBe('Plain Author');
        expect(created.memberships[0].workspace.name).toBe('Secret Desk');
        expect(await rawUserName(created.id)).toBe('Plain Author');
        const ws = created.memberships[0].workspace;
        expect(await rawWorkspaceName(ws.id)).toMatch(/^v1:/);

        // And a nested read opens the workspace through its relation.
        const read = await db.client.user.findUnique({ where: { id: created.id }, include: { memberships: { include: { workspace: true } } } });
        expect(read?.memberships[0].workspace.name).toBe('Secret Desk');
        expect(read?.name).toBe('Plain Author');
    });
});
