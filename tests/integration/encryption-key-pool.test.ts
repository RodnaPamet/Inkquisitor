/**
 * A workspace's data key is resolved BEFORE its transaction opens, never on a
 * second pooled connection while the transaction holds the first.
 *
 * With a one-connection pool, a key lookup made from inside the transaction
 * waits for a connection the transaction itself holds: the transaction times
 * out instead of finishing. This builds exactly that client (pool size 1, a
 * test manifest so the extension needs a key, a cold key cache) and runs
 * several workspace transactions at once; every one must complete.
 */
import { createDatabase, prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createAccount } from '../helpers/workspaces';

const db = createDatabase(process.env.DATABASE_URL, { manifest: { Workspace: ['name'] }, poolMax: 1 });
afterAll(() => Promise.all([db.client.$disconnect(), prisma.$disconnect()]));

const N = 4;
let accounts: Array<Awaited<ReturnType<typeof createAccount>>>;
beforeAll(async () => {
    accounts = [];
    for (let i = 0; i < N; i++) accounts.push(await createAccount({ workspaceName: `Pool ${i}` }));
});

it(`${N} concurrent cold-cache workspace transactions on a one-connection pool all complete`, async () => {
    db.keys.clear();
    expect(db.keys.size()).toBe(0);
    const results = await Promise.all(
        accounts.map((acc) =>
            runInWorkspaceContext(
                { workspaceId: acc.workspaceId, userId: acc.userId, requestId: 'pool-test' },
                async (tx) => {
                    const written = await tx.workspace.update({ where: { id: acc.workspaceId }, data: { name: `Sealed ${acc.workspaceId}` } });
                    const read = await tx.workspace.findUnique({ where: { id: acc.workspaceId } });
                    return { written: written.name, read: read?.name };
                },
                { client: db.client, timeout: 4_000 },
            ),
        ),
    );
    expect(results).toEqual(accounts.map((acc) => ({ written: `Sealed ${acc.workspaceId}`, read: `Sealed ${acc.workspaceId}` })));
    const atRest = await prisma.$queryRaw<Array<{ name: string }>>`SELECT "name" FROM "Workspace" WHERE "id" = ${accounts[0].workspaceId}`;
    expect(atRest[0].name).toMatch(/^v2:/);
}, 60_000);
