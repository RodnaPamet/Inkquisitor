/**
 * The database's own last-OWNER backstop (issue #11): the trigger
 * `workspace_membership_last_owner_guard` refuses, with SQLSTATE P0001, any
 * UPDATE or DELETE that would leave a workspace with no OWNER — whoever runs
 * it, past the usecase's check — and lets a workspace's own deletion cascade.
 *
 * Every write here goes AROUND `src/app-layer/usecases/members.ts` on
 * purpose: raw SQL, the plain client, and app_user inside the workspace's own
 * context. The usecase's refusal is tested in members.test.ts.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const GUARD = /LAST_OWNER_GUARD/;

async function ownerMembershipId(workspaceId: string, userId: string): Promise<string> {
    return (await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId, userId }, select: { id: true } })).id;
}

/** The SQLSTATE of a raw statement's refusal. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (err) {
        const meta = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; message?: string };
        const text = `${meta.message ?? ''} ${JSON.stringify(meta.meta ?? {})}`;
        if (/P0001/.test(text) || GUARD.test(text)) return 'P0001';
        return meta.code ?? 'other';
    }
}

it('a raw DELETE of the last OWNER is refused with P0001', async () => {
    const a = await createAccount();
    const id = await ownerMembershipId(a.workspaceId, a.userId);
    expect(await sqlstateOf(() => prisma.$executeRaw`DELETE FROM "WorkspaceMembership" WHERE "id" = ${id}`)).toBe('P0001');
    await expect(prisma.workspaceMembership.deleteMany({ where: { id } })).rejects.toThrow(GUARD);
    expect(await prisma.workspaceMembership.count({ where: { id } })).toBe(1);
});

it('a raw demotion of the last OWNER is refused', async () => {
    const a = await createAccount();
    const id = await ownerMembershipId(a.workspaceId, a.userId);
    expect(await sqlstateOf(() => prisma.$executeRaw`UPDATE "WorkspaceMembership" SET "role" = 'EDITOR' WHERE "id" = ${id}`)).toBe('P0001');
    await expect(prisma.workspaceMembership.update({ where: { id }, data: { role: 'READER' } })).rejects.toThrow(GUARD);
    expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id } })).role).toBe('OWNER');
});

it('app_user, inside the workspace’s own context, is refused too', async () => {
    const a = await createAccount();
    const id = await ownerMembershipId(a.workspaceId, a.userId);
    await expect(runInWorkspaceContext(workspaceCtx(a), (db) => db.workspaceMembership.deleteMany({ where: { id } }))).rejects.toThrow(GUARD);
    expect(await prisma.workspaceMembership.count({ where: { id } })).toBe(1);
});

it('with a second OWNER either may go, but not both', async () => {
    const a = await createAccount();
    const second = await createBareUser();
    const secondId = (await addMember(a.workspaceId, second.id, 'OWNER')).id;
    const firstId = await ownerMembershipId(a.workspaceId, a.userId);
    await prisma.workspaceMembership.update({ where: { id: firstId }, data: { role: 'EDITOR' } });
    await expect(prisma.workspaceMembership.delete({ where: { id: secondId } })).rejects.toThrow(GUARD);
    // Non-owners come and go freely.
    await prisma.workspaceMembership.delete({ where: { id: firstId } });
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
});

it('two transactions demoting each other at once cannot both commit (the lock is the usecase’s)', async () => {
    const a = await createAccount();
    const second = await createBareUser();
    const secondId = (await addMember(a.workspaceId, second.id, 'OWNER')).id;
    const firstId = await ownerMembershipId(a.workspaceId, a.userId);

    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((r) => (releaseFirst = r));
    let firstDemoted!: () => void;
    const firstHasDemoted = new Promise<void>((r) => (firstDemoted = r));

    const first = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "WorkspaceMembership" SET "role" = 'EDITOR' WHERE "id" = ${firstId}`;
        firstDemoted();
        await firstMayCommit;
    }, { timeout: 15_000 });
    await firstHasDemoted;
    const secondTx = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "WorkspaceMembership" SET "role" = 'EDITOR' WHERE "id" = ${secondId}`;
    }, { timeout: 15_000 });
    // The second waits on the advisory lock the first holds; let the first commit.
    await new Promise((r) => setTimeout(r, 300));
    releaseFirst();
    const [one, two] = await Promise.allSettled([first, secondTx]);
    expect(one.status).toBe('fulfilled');
    expect(two.status).toBe('rejected');
    expect(String((two as PromiseRejectedResult).reason)).toMatch(GUARD);
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: a.workspaceId, role: 'OWNER' } })).toBe(1);
});

it('a workspace’s own deletion cascades past the guard', async () => {
    const a = await createAccount();
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
    await prisma.workspace.delete({ where: { id: a.workspaceId } });
    expect(await prisma.workspace.count({ where: { id: a.workspaceId } })).toBe(0);
    expect(await prisma.workspaceMembership.count({ where: { workspaceId: a.workspaceId } })).toBe(0);
});

it('the guard function is VOLATILE (a STABLE one would count from a stale snapshot)', async () => {
    const rows = await prisma.$queryRaw<Array<{ provolatile: string }>>`
        SELECT provolatile::text AS provolatile FROM pg_proc WHERE proname = 'workspace_membership_not_last_owner'`;
    expect(rows).toEqual([{ provolatile: 'v' }]);
});
