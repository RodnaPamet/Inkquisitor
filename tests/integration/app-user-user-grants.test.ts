/**
 * What app_user — the role every workspace transaction runs as — may do with
 * `User`, a global table it reaches only to name a workspace's members.
 *
 * It may read the three columns a member list shows (id, name, email) and
 * nothing else: not the password hash, not the session version, and it may
 * not write a User row at all. Sign-in, sign-up and account linking touch
 * those on the owning connection (`runWithoutRls`), never as app_user.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { listMembers } from '@/app-layer/usecases/members';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let member: { id: string; email: string };
beforeAll(async () => {
    owner = await createAccount({ name: 'Grant Owner' });
    member = await createBareUser();
    await addMember(owner.workspaceId, member.id, 'READER');
});

const asApp = <T>(fn: Parameters<typeof runInWorkspaceContext<T>>[1]) =>
    runInWorkspaceContext({ workspaceId: owner.workspaceId, userId: owner.userId, requestId: 'grants-test' }, fn);

const PERMISSION_DENIED = /permission denied/i;

it('reading passwordHash is refused, through the client and through raw SQL', async () => {
    await expect(asApp((db) => db.user.findUnique({ where: { id: member.id }, select: { passwordHash: true } }))).rejects.toThrow(PERMISSION_DENIED);
    await expect(asApp((db) => db.$queryRaw`SELECT "passwordHash" FROM "User" WHERE "id" = ${member.id}`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asApp((db) => db.$queryRaw`SELECT * FROM "User" LIMIT 1`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asApp((db) => db.$queryRaw`SELECT "sessionVersion" FROM "User" LIMIT 1`)).rejects.toThrow(PERMISSION_DENIED);
});

it('updating, inserting or deleting a User row is refused', async () => {
    await expect(asApp((db) => db.$executeRaw`UPDATE "User" SET "name" = 'taken over' WHERE "id" = ${member.id}`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asApp((db) => db.$executeRaw`UPDATE "User" SET "passwordHash" = NULL WHERE "id" = ${member.id}`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asApp((db) => db.$executeRaw`DELETE FROM "User" WHERE "id" = ${member.id}`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(
        asApp((db) => db.$executeRaw`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('grant-probe', 'probe@example.test', now())`),
    ).rejects.toThrow(PERMISSION_DENIED);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).name).toBe('Member');
});

it('the member list still works: id, name and email are readable', async () => {
    const members = await listMembers(workspaceCtx(owner, 'OWNER'));
    expect(members.map((m) => m.userId).sort()).toEqual([owner.userId, member.id].sort());
    expect(members.find((m) => m.userId === member.id)).toMatchObject({ email: member.email, name: 'Member', role: 'READER' });
});
