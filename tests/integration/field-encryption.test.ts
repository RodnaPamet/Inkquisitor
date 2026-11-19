/**
 * Field encryption against a real database. The shipped manifest is empty
 * until Phase 1, so this builds a client with a TEST manifest
 * (`{ User: ['name'] }`) — the extension takes the manifest as a parameter for
 * exactly this — and proves: a listed field is ciphertext at rest, it reads
 * back as plaintext in the workspace that wrote it, it is refused under
 * another workspace's key, and nothing in the database ever holds the
 * plaintext.
 */
import { createDatabase, prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { DecryptIntegrityError } from '@/lib/db/encryption-middleware';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { createAccount, createBareUser } from '../helpers/workspaces';

const db = createDatabase(process.env.DATABASE_URL, { manifest: { User: ['name'] } });
// Two clients: the test one, and the singleton the fixtures write through.
afterAll(() => Promise.all([db.client.$disconnect(), prisma.$disconnect()]));

const SECRET_NAME = ['Mara', 'of', 'the', 'Salt', 'Roads'].join(' ');

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();
});

async function raw(id: string): Promise<string | null> {
    const rows = await db.client.$queryRaw<Array<{ name: string | null }>>`SELECT "name" FROM "User" WHERE "id" = ${id}`;
    return rows[0]?.name ?? null;
}

it('the shipped manifest is empty until Phase 1', () => {
    expect(ENCRYPTED_FIELDS).toEqual({});
});

it('a write inside a workspace is a v2 envelope at rest and reads back as plaintext there', async () => {
    const user = await createBareUser();
    const ctxA = { workspaceId: a.workspaceId, userId: a.userId, requestId: 'enc-test' };
    const written = await runInWorkspaceContext(ctxA, (tx) => tx.user.update({ where: { id: user.id }, data: { name: SECRET_NAME } }), { client: db.client });
    expect(written.name).toBe(SECRET_NAME);

    const atRest = await raw(user.id);
    expect(atRest).toMatch(/^v2:/);
    expect(atRest).not.toContain('Mara');

    const read = await runInWorkspaceContext(ctxA, (tx) => tx.user.findUnique({ where: { id: user.id } }), { client: db.client });
    expect(read?.name).toBe(SECRET_NAME);
});

it("another workspace's key refuses the ciphertext loudly; no workspace at all reads it as null", async () => {
    const user = await createBareUser();
    const ctxA = { workspaceId: a.workspaceId, userId: a.userId, requestId: 'enc-test' };
    await runInWorkspaceContext(ctxA, (tx) => tx.user.update({ where: { id: user.id }, data: { name: SECRET_NAME } }), { client: db.client });

    const ctxB = { workspaceId: b.workspaceId, userId: b.userId, requestId: 'enc-test' };
    await expect(runInWorkspaceContext(ctxB, (tx) => tx.user.findUnique({ where: { id: user.id } }), { client: db.client })).rejects.toBeInstanceOf(
        DecryptIntegrityError,
    );
    const outside = await db.client.user.findUnique({ where: { id: user.id } });
    expect(outside?.name).toBeNull();
});

it('a write outside any workspace is sealed under the master key (v1), never plaintext', async () => {
    const user = await createBareUser();
    await db.client.user.update({ where: { id: user.id }, data: { name: SECRET_NAME } });
    expect(await raw(user.id)).toMatch(/^v1:/);
    expect((await db.client.user.findUnique({ where: { id: user.id } }))?.name).toBe(SECRET_NAME);
});

it('is idempotent: re-saving an envelope does not double-encrypt it', async () => {
    const user = await createBareUser();
    const ctxA = { workspaceId: a.workspaceId, userId: a.userId, requestId: 'enc-test' };
    await runInWorkspaceContext(ctxA, (tx) => tx.user.update({ where: { id: user.id }, data: { name: SECRET_NAME } }), { client: db.client });
    const envelope = (await raw(user.id))!;
    await runInWorkspaceContext(ctxA, (tx) => tx.user.update({ where: { id: user.id }, data: { name: envelope } }), { client: db.client });
    expect(await raw(user.id)).toBe(envelope);
});
