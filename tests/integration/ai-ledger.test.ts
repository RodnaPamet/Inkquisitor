/**
 * The model layer's ledger against a real PostgreSQL (Phase 2.1):
 * `AiCallLog`, `AiSpendMonth` and `AiSpendReservation` under the workspace's
 * row-level security.
 *
 *   - a call is recorded in its workspace and invisible from another;
 *   - the call record is append-only for every role, and the workspace's and
 *     the book's cascades still delete it (the book's purge without lowering
 *     the month's spend); a deleted person's link is cleared, the record kept;
 *   - the spend ceiling holds under concurrency: of concurrent calls that
 *     each fit alone, only as many as fit together are admitted, and the rest
 *     are refused before anything is sent;
 *   - an expired reservation stops counting, and another month's spend never
 *     counts.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { callStructured, workspaceAiLedger } from '@/app-layer/usecases/model-calls';
import { AiSpendCeilingError } from '@/lib/ai/errors';
import { periodStartOf } from '@/lib/ai/call-record';
import { seedBible } from '../helpers/bible';
import { SEED_SCHEMA, SEED_TEMPLATE, seedAiCall, seedReservation } from '../helpers/ai-calls';
import { fakeAnthropic, setFakeApiKey } from '../helpers/fake-anthropic';
import { addMember, createAccount, createBareUser, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const id = () => `call-${randomBytes(6).toString('hex')}`;

let a: Awaited<ReturnType<typeof createAccount>>;
let b: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    a = await createAccount({ workspaceName: 'Ledger A' });
    b = await createAccount({ workspaceName: 'Ledger B' });
});

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
    try {
        await promise;
    } catch (err) {
        const e = err as { code?: string; message: string; meta?: { code?: string } };
        return { code: e.code ?? e.meta?.code, message: e.message };
    }
    throw new Error('expected a refusal');
}

describe('recording, under row-level security', () => {
    it('a call is recorded in its own workspace with numbers and names, and another workspace cannot see it', async () => {
        const callId = await seedAiCall(workspaceCtx(a), null, 'iso');
        const own = await runInWorkspaceContext(workspaceCtx(a), (db) => db.aiCallLog.findUnique({ where: { id: callId } }));
        expect(own).toMatchObject({
            workspaceId: a.workspaceId,
            outcome: 'OK',
            purpose: 'seed',
            promptId: 'test.seed',
            model: 'claude-haiku-5-5',
            tier: 'FAST',
            inputTokens: 500,
            outputTokens: 50,
            requestedById: a.userId,
        });
        // Haiku 5.5: $0.10 / $0.50 per MTok, rounded up.
        expect(own?.costMicroUsd).toBe(50 + 25);
        const fromB = await runInWorkspaceContext(workspaceCtx(b), (db) => db.aiCallLog.findUnique({ where: { id: callId } }));
        expect(fromB).toBeNull();
        const monthFromB = await runInWorkspaceContext(workspaceCtx(b), (db) =>
            db.aiSpendMonth.findMany({ where: { workspaceId: a.workspaceId }, take: 5 }),
        );
        expect(monthFromB).toEqual([]);
    });

    it('a row with free text in a code column is refused by the database', async () => {
        const err = await errorOf(
            runInWorkspaceContext(workspaceCtx(a), (db) =>
                db.aiCallLog.create({
                    data: {
                        id: id(),
                        workspaceId: a.workspaceId,
                        purpose: 'She keeps the lighthouse alone',
                        promptId: 'p',
                        promptVersion: '1',
                        tier: 'FAST',
                        model: 'claude-haiku-5-5',
                        attempts: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        costMicroUsd: 0,
                        costEstimated: false,
                        worstCaseMicroUsd: 0,
                        durationMs: 0,
                        outcome: 'KILLED',
                        errorCode: 'AI_DISABLED',
                        guardRuleIds: [],
                        guardReviewRequired: false,
                        startedAt: new Date(),
                    },
                }),
            ),
        );
        expect(err.message).toMatch(/AiCallLog_purpose_shape/);
    });
});

describe('append-only, with the cascades', () => {
    it('refuses UPDATE, DELETE and TRUNCATE for the owner, and app_user holds no UPDATE or DELETE', async () => {
        const callId = await seedAiCall(workspaceCtx(a), null, 'ro');
        expect((await errorOf(prisma.aiCallLog.update({ where: { id: callId }, data: { costMicroUsd: 0 } }))).message).toMatch(/AI_CALL_LOG_APPEND_ONLY/);
        expect((await errorOf(prisma.aiCallLog.delete({ where: { id: callId } }))).message).toMatch(/AI_CALL_LOG_APPEND_ONLY/);
        expect((await errorOf(prisma.$executeRawUnsafe('TRUNCATE "AiCallLog"'))).message).toMatch(/AI_CALL_LOG_APPEND_ONLY/);
        const asApp = await errorOf(
            runInWorkspaceContext(workspaceCtx(a), (db) => db.aiCallLog.updateMany({ where: { id: callId }, data: { costMicroUsd: 0 } })),
        );
        expect(asApp.message).toMatch(/permission denied/);
        expect(await prisma.aiCallLog.count({ where: { id: callId } })).toBe(1);
    });

    it('the book’s purge deletes the book’s call records, and the month’s spend stays', async () => {
        const ctx = workspaceCtx(a);
        const { bookId } = await seedBible(ctx, `ai-purge-${randomBytes(3).toString('hex')}`);
        const bookCall = await seedAiCall(ctx, bookId, 'book');
        const looseCall = await seedAiCall(ctx, null, 'loose');
        const month = () =>
            prisma.aiSpendMonth.findUnique({ where: { workspaceId_periodStart: { workspaceId: a.workspaceId, periodStart: periodStartOf(new Date()) } } });
        const spentBefore = (await month())?.spentMicroUsd;
        expect(spentBefore).toBeGreaterThan(BigInt(0));

        await prisma.book.update({ where: { id: bookId }, data: { deletedAt: new Date(Date.now() - 31 * DAY) } });
        await prisma.book.delete({ where: { id: bookId } });

        expect(await prisma.aiCallLog.count({ where: { id: bookCall } })).toBe(0);
        expect(await prisma.aiCallLog.count({ where: { id: looseCall } })).toBe(1);
        expect((await month())?.spentMicroUsd).toBe(spentBefore);
    });

    it('a deleted person’s link is cleared and the record kept', async () => {
        const editor = await createBareUser();
        await addMember(a.workspaceId, editor.id, 'EDITOR');
        const callId = await seedAiCall({ ...workspaceCtx(a, 'EDITOR'), userId: editor.id }, null, 'editor');
        await prisma.user.delete({ where: { id: editor.id } });
        expect(await prisma.aiCallLog.findUnique({ where: { id: callId }, select: { requestedById: true, outcome: true } })).toEqual({
            requestedById: null,
            outcome: 'OK',
        });
    });

    it('the requestedById exception clears that column ONLY: any other change in the same UPDATE is refused', async () => {
        // Leave a record pointing at a person who no longer exists, the state the
        // ON DELETE SET NULL action meets (replica mode skips the FK action and
        // the append-only trigger alike, for this setup step only).
        const ghost = await createBareUser();
        await addMember(a.workspaceId, ghost.id, 'EDITOR');
        const callId = await seedAiCall({ ...workspaceCtx(a, 'EDITOR'), userId: ghost.id }, null, 'ghost');
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
            await tx.$executeRaw`DELETE FROM "WorkspaceMembership" WHERE "userId" = ${ghost.id}`;
            await tx.$executeRaw`DELETE FROM "User" WHERE "id" = ${ghost.id}`;
        });
        const sneak = await errorOf(
            prisma.$executeRaw`UPDATE "AiCallLog" SET "requestedById" = NULL, "costMicroUsd" = 0 WHERE "id" = ${callId}`,
        );
        expect(sneak.message).toMatch(/AI_CALL_LOG_APPEND_ONLY/);
        expect(await prisma.$executeRaw`UPDATE "AiCallLog" SET "requestedById" = NULL WHERE "id" = ${callId}`).toBe(1);
        const row = await prisma.aiCallLog.findUnique({ where: { id: callId }, select: { requestedById: true, costMicroUsd: true } });
        expect(row?.requestedById).toBeNull();
        expect(row?.costMicroUsd).toBeGreaterThan(0);
        // And a person who still exists is never unlinked.
        const kept = await seedAiCall(workspaceCtx(a), null, 'kept');
        expect((await errorOf(prisma.$executeRaw`UPDATE "AiCallLog" SET "requestedById" = NULL WHERE "id" = ${kept}`)).message).toMatch(
            /AI_CALL_LOG_APPEND_ONLY/,
        );
    });

    it('a settlement repeated for the same call charges the month once', async () => {
        const fresh = await createAccount({ workspaceName: 'Ledger Twice' });
        const ctx = workspaceCtx(fresh);
        const callId = await seedAiCall(ctx, null, 'twice');
        const record = await prisma.aiCallLog.findUniqueOrThrow({ where: { id: callId } });
        const month = () =>
            prisma.aiSpendMonth.findUniqueOrThrow({ where: { workspaceId_periodStart: { workspaceId: fresh.workspaceId, periodStart: periodStartOf(record.startedAt) } } });
        const before = (await month()).spentMicroUsd;
        await expect(
            workspaceAiLedger(ctx).settle({
                ...record,
                tier: 'fast',
                outputMode: 'json_schema',
                outcome: 'OK',
                errorCode: null,
            }),
        ).rejects.toThrow();
        expect((await month()).spentMicroUsd).toBe(before);
        expect(await prisma.aiCallLog.count({ where: { id: callId } })).toBe(1);
    });

    it('the workspace’s cascade deletes its call records, spend and reservations', async () => {
        const gone = await createAccount({ workspaceName: 'Ledger Gone' });
        await seedAiCall(workspaceCtx(gone), null, 'gone');
        await seedReservation(workspaceCtx(gone), id());
        await prisma.workspace.delete({ where: { id: gone.workspaceId } });
        expect(await prisma.aiCallLog.count({ where: { workspaceId: gone.workspaceId } })).toBe(0);
        expect(await prisma.aiSpendMonth.count({ where: { workspaceId: gone.workspaceId } })).toBe(0);
        expect(await prisma.aiSpendReservation.count({ where: { workspaceId: gone.workspaceId } })).toBe(0);
    });
});

describe('the spend ceiling, under concurrency', () => {
    it('of eight concurrent reservations that each fit alone, exactly as many as fit together are admitted', async () => {
        const fresh = await createAccount({ workspaceName: 'Ceiling Race' });
        const ledger = workspaceAiLedger(workspaceCtx(fresh));
        const startedAt = new Date();
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                ledger.reserve({ callId: id(), amountMicroUsd: 600_000, ceilingMicroUsd: 1_000_000, ttlMs: 60_000, startedAt }),
            ),
        );
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const held = await prisma.aiSpendReservation.aggregate({ where: { workspaceId: fresh.workspaceId }, _sum: { amountMicroUsd: true } });
        expect(held._sum.amountMicroUsd).toBe(600_000);
    });

    it('concurrent model calls: while two are in flight, the rest are refused CEILING and never sent', async () => {
        const fresh = await createAccount({ workspaceName: 'Ceiling Calls' });
        const ctx = workspaceCtx(fresh);
        const restore = setFakeApiKey();
        try {
            // One call's worst case, from a solo call in another workspace.
            const probe = await createAccount({ workspaceName: 'Ceiling Probe' });
            await seedAiCall(workspaceCtx(probe), null, 'probe');
            const worst = (await prisma.aiCallLog.findFirst({ where: { workspaceId: probe.workspaceId }, select: { worstCaseMicroUsd: true } }))!
                .worstCaseMicroUsd;
            // Room for two worst cases and not three.
            const ceilingUsd = ((2 * worst + worst / 2) / 1_000_000).toFixed(6);
            // The admitted calls are held in flight until every refusal is in.
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const api = fakeAnthropic(Array.from({ length: 6 }, () => ({ kind: 'gated' as const, gate, text: JSON.stringify({ thing: 'x' }) })));
            let settled = 0;
            const calls = Array.from({ length: 6 }, () =>
                callStructured(
                    ctx,
                    { template: SEED_TEMPLATE, data: [{ label: 'note', text: 'Material probe.' }], schema: SEED_SCHEMA },
                    { fetch: api.fetch, env: { AI_MONTHLY_CEILING_USD_DEFAULT: ceilingUsd } },
                ).then(
                    () => 'ok' as const,
                    (e: unknown) => (e instanceof AiSpendCeilingError ? ('ceiling' as const) : e),
                ).finally(() => {
                    settled += 1;
                }),
            );
            for (let i = 0; i < 500 && settled < 4; i++) await new Promise((r) => setTimeout(r, 10));
            expect(settled).toBe(4);
            expect(api.requests).toHaveLength(2);
            release();
            const outcomes = await Promise.all(calls);
            expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
            expect(outcomes.filter((o) => o === 'ceiling')).toHaveLength(4);
            expect(api.requests).toHaveLength(2);
            const rows = await prisma.aiCallLog.groupBy({ by: ['outcome'], where: { workspaceId: fresh.workspaceId }, _count: true });
            expect(Object.fromEntries(rows.map((r) => [r.outcome, r._count]))).toEqual({ OK: 2, CEILING: 4 });
            expect(await prisma.aiSpendReservation.count({ where: { workspaceId: fresh.workspaceId } })).toBe(0);
        } finally {
            restore();
        }
    });

    it('while two worst cases are HELD, a third concurrent call is refused before anything is sent', async () => {
        const fresh = await createAccount({ workspaceName: 'Ceiling Held' });
        const ctx = workspaceCtx(fresh);
        await seedReservation(ctx, id(), 400_000);
        await seedReservation(ctx, id(), 400_000);
        const restore = setFakeApiKey();
        try {
            const api = fakeAnthropic([{ kind: 'text', text: JSON.stringify({ thing: 'x' }) }]);
            const err = await callStructured(
                ctx,
                { template: SEED_TEMPLATE, data: [], schema: z.object({ thing: z.string() }) },
                { fetch: api.fetch, env: { AI_MONTHLY_CEILING_USD_DEFAULT: '0.801' } },
            ).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(AiSpendCeilingError);
            expect((err as AiSpendCeilingError).details).toMatchObject({ reservedMicroUsd: 800_000, ceilingMicroUsd: 801_000 });
            expect(api.requests).toHaveLength(0);
        } finally {
            restore();
        }
    });

    it('an expired reservation (its process died) stops counting', async () => {
        const fresh = await createAccount({ workspaceName: 'Ceiling Expired' });
        const ledger = workspaceAiLedger(workspaceCtx(fresh));
        const startedAt = new Date();
        expect((await ledger.reserve({ callId: id(), amountMicroUsd: 900_000, ceilingMicroUsd: 1_000_000, ttlMs: 1, startedAt })).ok).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
        expect((await ledger.reserve({ callId: id(), amountMicroUsd: 900_000, ceilingMicroUsd: 1_000_000, ttlMs: 60_000, startedAt })).ok).toBe(true);
    });

    it('counts this UTC month only: last month’s spend never counts against this one', async () => {
        const fresh = await createAccount({ workspaceName: 'Ceiling Month' });
        const now = new Date();
        const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        await prisma.aiSpendMonth.create({ data: { workspaceId: fresh.workspaceId, periodStart: lastMonth, spentMicroUsd: BigInt(5_000_000) } });
        const ledger = workspaceAiLedger(workspaceCtx(fresh));
        expect((await ledger.reserve({ callId: id(), amountMicroUsd: 900_000, ceilingMicroUsd: 1_000_000, ttlMs: 60_000, startedAt: now })).ok).toBe(true);
        await prisma.aiSpendMonth.create({ data: { workspaceId: fresh.workspaceId, periodStart: periodStartOf(now), spentMicroUsd: BigInt(200_000) } });
        const refused = await ledger.reserve({ callId: id(), amountMicroUsd: 1, ceilingMicroUsd: 1_000_000, ttlMs: 60_000, startedAt: now });
        expect(refused).toMatchObject({ ok: false, spentMicroUsd: 200_000, reservedMicroUsd: 900_000 });
    });
});
