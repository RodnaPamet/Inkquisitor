/**
 * Two workspaces, and the app role between them.
 *
 * `runInWorkspaceContext` runs its transaction as app_user with
 * `app.workspace_id` set; every workspace-scoped table's `workspace_isolation`
 * policy then limits what the transaction can read, insert, update and delete
 * to that workspace. These tests go through the real client against a real
 * PostgreSQL and try every way across: read, update, delete, insert with the
 * other workspace's id, and moving an own row into the other workspace. Each
 * must be refused BY THE DATABASE — the queries below deliberately carry no
 * `workspaceId` filter of their own.
 */
import { prisma } from '@/lib/db';
import { runInWorkspaceContext, runWithoutRls } from '@/lib/db/rls-middleware';
import { appendAuditEntry } from '@/lib/audit/audit-writer';
import { addMember, createAccount, createBareUser } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
let bMembershipId: string;
let aMembershipId: string;

beforeAll(async () => {
    a = await createAccount({ workspaceName: 'Isolation A' });
    b = await createAccount({ workspaceName: 'Isolation B' });
    bMembershipId = (await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId: b.workspaceId } })).id;
    aMembershipId = (await prisma.workspaceMembership.findFirstOrThrow({ where: { workspaceId: a.workspaceId } })).id;
    await appendAuditEntry({ workspaceId: b.workspaceId, actorUserId: b.userId, action: 'PROBE', entityType: 'Test', entityId: null });
});

const inA = <T>(fn: Parameters<typeof runInWorkspaceContext<T>>[1]) =>
    runInWorkspaceContext({ workspaceId: a.workspaceId, userId: a.userId, requestId: 'isolation-test' }, fn);

describe('the context really is the app role', () => {
    it('runs as app_user with the workspace bound', async () => {
        const [row] = await inA((db) =>
            db.$queryRaw<Array<{ who: string; ws: string }>>`SELECT current_user AS who, current_setting('app.workspace_id', true) AS ws`,
        );
        expect(row).toEqual({ who: 'app_user', ws: a.workspaceId });
    });

    it('the bypass sees both workspaces (the rows exist; only the policy hides them)', async () => {
        const ids = await runWithoutRls({ reason: 'test' }, (db) =>
            db.workspace.findMany({ where: { id: { in: [a.workspaceId, b.workspaceId] } }, select: { id: true } }),
        );
        expect(ids.map((r) => r.id).sort()).toEqual([a.workspaceId, b.workspaceId].sort());
    });
});

describe('workspace A cannot READ workspace B', () => {
    it('sees only its own workspace row', async () => {
        const rows = await inA((db) => db.workspace.findMany({ select: { id: true } }));
        expect(rows.map((r) => r.id)).toEqual([a.workspaceId]);
    });

    it("cannot find B's workspace by id or by slug", async () => {
        expect(await inA((db) => db.workspace.findUnique({ where: { id: b.workspaceId } }))).toBeNull();
        expect(await inA((db) => db.workspace.findUnique({ where: { slug: b.workspaceSlug } }))).toBeNull();
    });

    it('sees only its own memberships', async () => {
        const rows = await inA((db) => db.workspaceMembership.findMany({ select: { workspaceId: true } }));
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([a.workspaceId]));
        expect(await inA((db) => db.workspaceMembership.findUnique({ where: { id: bMembershipId } }))).toBeNull();
    });

    it("sees only its own audit trail, even through raw SQL", async () => {
        const rows = await inA((db) => db.$queryRaw<Array<{ workspaceId: string }>>`SELECT "workspaceId" FROM "AuditLog"`);
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set([a.workspaceId]));
    });
});

describe('workspace A cannot WRITE workspace B', () => {
    it("an update aimed at B's rows changes nothing", async () => {
        const ws = await inA((db) => db.workspace.updateMany({ where: { id: b.workspaceId }, data: { name: 'taken over' } }));
        const member = await inA((db) => db.workspaceMembership.updateMany({ where: { id: bMembershipId }, data: { role: 'READER' } }));
        expect(ws.count).toBe(0);
        expect(member.count).toBe(0);
        const after = await prisma.workspace.findUniqueOrThrow({ where: { id: b.workspaceId } });
        expect(after.name).toBe('Isolation B');
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: bMembershipId } })).role).toBe('OWNER');
    });

    it("a delete aimed at B's rows removes nothing", async () => {
        const res = await inA((db) => db.workspaceMembership.deleteMany({ where: { id: bMembershipId } }));
        expect(res.count).toBe(0);
        expect(await prisma.workspaceMembership.findUnique({ where: { id: bMembershipId } })).not.toBeNull();
    });

    it("an insert carrying B's workspaceId is refused", async () => {
        const intruder = await createBareUser();
        await expect(inA((db) => db.workspaceMembership.create({ data: { workspaceId: b.workspaceId, userId: intruder.id, role: 'OWNER' } }))).rejects.toThrow(
            /row-level security|violates/i,
        );
        expect(await prisma.workspaceMembership.findFirst({ where: { workspaceId: b.workspaceId, userId: intruder.id } })).toBeNull();
    });

    it("an audit row carrying B's workspaceId is refused", async () => {
        await expect(
            inA((db) =>
                db.$executeRaw`INSERT INTO "AuditLog" ("id","workspaceId","actorType","action","entityType","detailsJson","entryHash")
                               VALUES (${'forged-' + Date.now()}, ${b.workspaceId}, 'USER', 'FORGED', 'Test', '{}'::jsonb, 'x')`,
            ),
        ).rejects.toThrow(/row-level security|violates/i);
    });

    it('an own row cannot be moved into B (WITH CHECK)', async () => {
        // A non-owner row: moving A's only OWNER out is refused earlier, by the
        // last-owner trigger (tests/integration/last-owner-guard.test.ts), and
        // this case is about the policy.
        const editor = await createBareUser();
        const editorRowId = (await prisma.workspaceMembership.create({ data: { workspaceId: a.workspaceId, userId: editor.id, role: 'EDITOR' } })).id;
        await expect(inA((db) => db.workspaceMembership.update({ where: { id: editorRowId }, data: { workspaceId: b.workspaceId } }))).rejects.toThrow(
            /row-level security|violates/i,
        );
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: editorRowId } })).workspaceId).toBe(a.workspaceId);
        // A's OWNER row cannot be moved either, whichever layer says so first.
        await expect(inA((db) => db.workspaceMembership.update({ where: { id: aMembershipId }, data: { workspaceId: b.workspaceId } }))).rejects.toThrow(
            /row-level security|violates|LAST_OWNER_GUARD/i,
        );
        expect((await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: aMembershipId } })).workspaceId).toBe(a.workspaceId);
    });

    it('an own insert is allowed (the policy is not simply closed)', async () => {
        const member = await createBareUser();
        const row = await inA((db) => db.workspaceMembership.create({ data: { workspaceId: a.workspaceId, userId: member.id, role: 'READER' } }));
        expect(row.workspaceId).toBe(a.workspaceId);
    });
});

describe('the app role fails closed', () => {
    it('with no workspace bound it sees nothing at all', async () => {
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE app_user`;
            return tx.workspaceMembership.findMany({ select: { id: true } });
        });
        expect(rows).toEqual([]);
    });

    it('holds no grant on the identity tables only the plain client reads', async () => {
        for (const table of ['UserSession', 'Account', 'VerificationToken']) {
            await expect(inA((db) => db.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`))).rejects.toThrow(/permission denied/i);
        }
    });

    it('cannot add a member to its own workspace for another workspace by membership of both', async () => {
        // A person who belongs to both workspaces still reaches B only through B's context.
        await addMember(b.workspaceId, a.userId, 'EDITOR');
        const rows = await inA((db) => db.workspaceMembership.findMany({ where: { userId: a.userId }, select: { workspaceId: true } }));
        expect(rows.map((r) => r.workspaceId)).toEqual([a.workspaceId]);
    });
});
