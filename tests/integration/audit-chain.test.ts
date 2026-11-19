/**
 * The audit trail is hash-chained per workspace and append-only for every
 * role, including the owning role and a superuser.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { appendAuditEntry, verifyAuditChain } from '@/lib/audit/audit-writer';
import { logEvent } from '@/app-layer/events/audit';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { createAccount } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    a = await createAccount();
    b = await createAccount();
});

it('a workspace’s chain verifies, each row linking to the one before', async () => {
    for (let i = 0; i < 3; i++) {
        await logEvent({ requestId: randomUUID(), userId: a.userId, workspaceId: a.workspaceId }, { action: 'MEMBERSHIP_ROLE_CHANGED', entityType: 'Test', entityId: String(i), details: { n: i } });
    }
    const rows = await prisma.auditLog.findMany({ where: { workspaceId: a.workspaceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(rows.length).toBeGreaterThanOrEqual(6); // three from sign-up, three here
    expect(rows[0].previousHash).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].previousHash).toBe(rows[i - 1].entryHash);
    expect(await verifyAuditChain(a.workspaceId)).toMatchObject({ valid: true, totalEntries: rows.length });
});

it('concurrent appends to one workspace still form a single chain', async () => {
    await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
            appendAuditEntry({ workspaceId: b.workspaceId, actorUserId: b.userId, action: 'CONCURRENT', entityType: 'Test', entityId: String(i) }),
        ),
    );
    const result = await verifyAuditChain(b.workspaceId);
    expect(result.valid).toBe(true);
    const rows = await prisma.auditLog.findMany({ where: { workspaceId: b.workspaceId } });
    // No fork: every previousHash is distinct.
    const prevs = rows.map((r) => r.previousHash);
    expect(new Set(prevs).size).toBe(prevs.length);
});

it('chains are per workspace: one workspace’s rows never link into another’s', async () => {
    const rowsB = await prisma.auditLog.findMany({ where: { workspaceId: b.workspaceId }, select: { previousHash: true } });
    const hashesA = new Set((await prisma.auditLog.findMany({ where: { workspaceId: a.workspaceId }, select: { entryHash: true } })).map((r) => r.entryHash));
    expect(rowsB.some((r) => r.previousHash && hashesA.has(r.previousHash))).toBe(false);
});

it('verification finds a forged row', async () => {
    const c = await createAccount();
    await prisma.$executeRaw`
        INSERT INTO "AuditLog" ("id","workspaceId","actorType","action","entityType","detailsJson","entryHash","previousHash","createdAt")
        VALUES (${randomUUID()}, ${c.workspaceId}, 'USER', 'FORGED', 'Test', '{}'::jsonb, ${'0'.repeat(64)}, NULL, now() + interval '1 hour')`;
    const result = await verifyAuditChain(c.workspaceId);
    expect(result.valid).toBe(false);
    expect(result.firstBreakAt).toBe(3);
});

describe('append-only, for every role', () => {
    it('refuses UPDATE and DELETE on the owning (superuser) connection — the trigger', async () => {
        const row = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: a.workspaceId } });
        await expect(prisma.$executeRaw`UPDATE "AuditLog" SET "action" = 'REWRITTEN' WHERE "id" = ${row.id}`).rejects.toThrow(/append-only/);
        await expect(prisma.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${row.id}`).rejects.toThrow(/append-only/);
        await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/append-only/);
        expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe(row.action);
    });

    it('refuses UPDATE and DELETE for the app role inside its own workspace — no grant', async () => {
        const row = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId: a.workspaceId } });
        const ctx = { workspaceId: a.workspaceId, userId: a.userId, requestId: 'audit-test' };
        await expect(runInWorkspaceContext(ctx, (db) => db.$executeRaw`UPDATE "AuditLog" SET "action" = 'X' WHERE "id" = ${row.id}`)).rejects.toThrow(
            /permission denied|append-only/,
        );
        await expect(runInWorkspaceContext(ctx, (db) => db.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${row.id}`)).rejects.toThrow(
            /permission denied|append-only/,
        );
    });

    it('the chain still verifies after the refused attempts', async () => {
        expect((await verifyAuditChain(a.workspaceId)).valid).toBe(true);
    });
});
