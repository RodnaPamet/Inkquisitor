/**
 * Phase 2.H, the security half, against a real PostgreSQL:
 *
 *   - money columns are BIGINT: a call costing more than $2,147 is recorded
 *     (issue #30 item 8);
 *   - app_user cannot backdate a book's deletion to purge it early: a newly
 *     set `deletedAt` is the database's clock (issue #29 item 2);
 *   - an element-name check made while a create of an equivalent name is in
 *     flight sees it once it commits: the book's names lock (issues #39 item
 *     5, #41 item 5);
 *   - the call log's retention: app_user can never delete a record, the job
 *     deletes those past the retention and keeps the rest, and no role deletes
 *     a record younger than the trigger's floor (issue #30 item 4).
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { runInWorkspaceContext } from '@/lib/db/rls-middleware';
import { workspaceAiLedger } from '@/app-layer/usecases/model-calls';
import { createElementInTx, createElement, updateElement } from '@/app-layer/usecases/bible-elements';
import { restoreVersion } from '@/app-layer/usecases/bible-versions';
import { bookHoldsElementName } from '@/app-layer/usecases/enrichment-names';
import { deleteBook } from '@/app-layer/usecases/books';
import { purgeExpiredAiCallLogs } from '@/app-layer/usecases/ai-call-retention';
import { RETENTION_FLOOR_DAYS } from '@/lib/ai/call-log-retention';
import type { AiCallRecord } from '@/lib/ai/call-record';
import { seedBible } from '../helpers/bible';
import { seedAiCall } from '../helpers/ai-calls';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;

let account: Awaited<ReturnType<typeof createAccount>>;
beforeAll(async () => {
    account = await createAccount({ workspaceName: 'Hardening 2.H' });
});

function record(over: Partial<AiCallRecord> = {}): AiCallRecord {
    return {
        id: `call-${randomBytes(6).toString('hex')}`,
        bookId: null,
        requestedById: null,
        purpose: 'test.bigint',
        promptId: 'test.bigint',
        promptVersion: '1',
        tier: 'deep',
        model: 'claude-opus-5-5',
        outputMode: 'json_schema',
        attempts: 1,
        inputTokens: 900_000,
        outputTokens: 32_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 2_500_000_000,
        costEstimated: false,
        worstCaseMicroUsd: 3_000_000_000,
        durationMs: 10,
        outcome: 'OK',
        errorCode: null,
        guardRuleIds: [],
        guardReviewRequired: false,
        startedAt: new Date(),
        ...over,
    };
}

describe('money columns are BIGINT (issue #30 item 8)', () => {
    it('settles a call costing $2,500 (past the INTEGER bound) and holds a reservation as large', async () => {
        // A workspace of its own: this month's spend would pass every other test's ceiling.
        const ctx = workspaceCtx(await createAccount({ workspaceName: 'Hardening BIGINT' }));
        const ledger = workspaceAiLedger(ctx);
        const r = record();
        expect((await ledger.reserve({ callId: r.id, amountMicroUsd: 3_000_000_000, ceilingMicroUsd: 10_000_000_000, ttlMs: 60_000, startedAt: r.startedAt })).ok).toBe(true);
        await ledger.settle(r);
        const row = await prisma.aiCallLog.findUniqueOrThrow({ where: { id: r.id } });
        expect(row.costMicroUsd).toBe(BigInt(2_500_000_000));
        expect(row.worstCaseMicroUsd).toBe(BigInt(3_000_000_000));
    });
});

describe('a deletion time is the database’s (issue #29 item 2)', () => {
    it('app_user’s backdated deletedAt is pinned to now, so the purge window cannot be skipped', async () => {
        const ctx = workspaceCtx(account);
        const { bookId } = await seedBible(ctx, `backdate-${randomBytes(3).toString('hex')}`);
        const longAgo = new Date(Date.now() - 400 * DAY);
        await runInWorkspaceContext(ctx, (db) => db.book.updateMany({ where: { id: bookId }, data: { deletedAt: longAgo } }));
        const pinned = (await prisma.book.findUniqueOrThrow({ where: { id: bookId } })).deletedAt!;
        expect(Math.abs(pinned.getTime() - Date.now())).toBeLessThan(60_000);
        // And so app_user's delete is refused as not yet due.
        await expect(runInWorkspaceContext(ctx, (db) => db.book.deleteMany({ where: { id: bookId } }))).rejects.toThrow(/BOOK_DELETE_NOT_DUE/);
        expect(await prisma.book.count({ where: { id: bookId } })).toBe(1);
    });

    it('a change to an already set time is pinned too; a restore (NULL) is untouched; the usecase still deletes', async () => {
        const ctx = workspaceCtx(account);
        const { bookId } = await seedBible(ctx, `pin-${randomBytes(3).toString('hex')}`);
        await deleteBook(ctx, bookId);
        await runInWorkspaceContext(ctx, (db) => db.book.updateMany({ where: { id: bookId }, data: { deletedAt: new Date(Date.now() - 90 * DAY) } }));
        expect(Date.now() - (await prisma.book.findUniqueOrThrow({ where: { id: bookId } })).deletedAt!.getTime()).toBeLessThan(60_000);
        await runInWorkspaceContext(ctx, (db) => db.book.updateMany({ where: { id: bookId }, data: { deletedAt: null } }));
        expect((await prisma.book.findUniqueOrThrow({ where: { id: bookId } })).deletedAt).toBeNull();
    });

    it('the fixtures’ seam: a role other than app_user may still backdate', async () => {
        const { bookId } = await seedBible(workspaceCtx(account), `seam-${randomBytes(3).toString('hex')}`);
        const longAgo = new Date(Date.now() - 31 * DAY);
        await prisma.book.update({ where: { id: bookId }, data: { deletedAt: longAgo } });
        expect((await prisma.book.findUniqueOrThrow({ where: { id: bookId } })).deletedAt!.getTime()).toBe(longAgo.getTime());
    });
});

describe('equivalent element names cannot both be created past a check (issues #39 item 5, #41 item 5)', () => {
    it('a name check waits for an in-flight create and sees its name once it commits', async () => {
        const ctx = workspaceCtx(account);
        const { bookId } = await seedBible(ctx, `names-${randomBytes(3).toString('hex')}`);
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let created!: () => void;
        const insertDone = new Promise<void>((r) => (created = r));

        // A manual create of "The Drainage Board", held open after its insert.
        const creating = runInWorkspaceContext(ctx, async (db) => {
            await createElementInTx(db, ctx, bookId, { kind: 'FACTION', name: 'The Drainage Board', summary: null, customLabel: null, fields: [] }, { source: 'MANUAL', changeSummary: null });
            created();
            await gate;
        });
        await insertDone;

        // An accept's check for "Drainage Board" while that create is uncommitted.
        let answered = false;
        const checking = runInWorkspaceContext(ctx, async (db) => {
            const held = await bookHoldsElementName(db, ctx, bookId, 'Drainage Board');
            answered = true;
            return held;
        });
        await new Promise((r) => setTimeout(r, 300));
        // It waits on the book's names lock rather than answering "not held".
        expect(answered).toBe(false);
        release();
        await creating;
        expect(await checking).toBe(true);
    });

    it('a restore (which can bring an old name back) waits for an in-flight name check, as a rename does', async () => {
        const ctx = workspaceCtx(account);
        const { bookId, characterId } = await seedBible(ctx, `names3-${randomBytes(3).toString('hex')}`);
        await updateElement(ctx, bookId, characterId, { name: 'Ilse Varga', baseVersion: 1 });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let checked!: () => void;
        const checkDone = new Promise<void>((r) => (checked = r));

        // An accept's name check, held open after it answered (its lock held to commit).
        const checking = runInWorkspaceContext(ctx, async (db) => {
            const held = await bookHoldsElementName(db, ctx, bookId, 'Some New Name');
            checked();
            await gate;
            return held;
        });
        await checkDone;

        let restored = false;
        const restoring = restoreVersion(ctx, bookId, characterId, 1, { baseVersion: 2 }).then((r) => {
            restored = true;
            return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        // The restore renames the element back: it waits on the book's names lock.
        expect(restored).toBe(false);
        release();
        expect(await checking).toBe(false);
        expect((await restoring).version.versionNumber).toBe(3);
    });

    it('two concurrent creates through the usecase both still succeed (a manual create never refuses a name): only checks wait', async () => {
        const ctx = workspaceCtx(account);
        const { bookId } = await seedBible(ctx, `names2-${randomBytes(3).toString('hex')}`);
        const made = await Promise.all([createElement(ctx, bookId, { kind: 'SETTING', name: 'Wennaway' }), createElement(ctx, bookId, { kind: 'SETTING', name: 'The Wennaway' })]);
        expect(made).toHaveLength(2);
    });
});

describe('the call log’s retention (issue #30 item 4)', () => {
    async function oldCall(daysAgo: number): Promise<string> {
        const callId = await seedAiCall(workspaceCtx(account), null, 'retention');
        // A superuser may not UPDATE a call record either (append-only): insert a copy, backdated.
        const row = await prisma.aiCallLog.findUniqueOrThrow({ where: { id: callId } });
        const copy = `${callId}-old`;
        await prisma.aiCallLog.create({ data: { ...row, id: copy, startedAt: new Date(Date.now() - daysAgo * DAY), createdAt: undefined } });
        return copy;
    }

    it('app_user can never delete a record, however old', async () => {
        const id = await oldCall(RETENTION_FLOOR_DAYS + 100);
        await expect(runInWorkspaceContext(workspaceCtx(account), (db) => db.aiCallLog.deleteMany({ where: { id } }))).rejects.toThrow(/permission denied|AI_CALL_LOG_APPEND_ONLY/);
        expect(await prisma.aiCallLog.count({ where: { id } })).toBe(1);
    });

    it('no role deletes a record younger than the trigger’s floor', async () => {
        const id = await oldCall(RETENTION_FLOOR_DAYS - 5);
        await expect(prisma.aiCallLog.delete({ where: { id } })).rejects.toThrow(/AI_CALL_LOG_APPEND_ONLY/);
    });

    it('the job deletes what is past the retention and keeps the rest, the month’s spend untouched', async () => {
        const expired = await oldCall(500);
        const kept = await oldCall(380);
        const recent = await seedAiCall(workspaceCtx(account), null, 'recent');
        const months = await prisma.aiSpendMonth.findMany({ where: { workspaceId: account.workspaceId }, take: 50 });
        const r = await purgeExpiredAiCallLogs({ days: 400 });
        expect(r.deleted).toBeGreaterThanOrEqual(1);
        expect(await prisma.aiCallLog.count({ where: { id: expired } })).toBe(0);
        expect(await prisma.aiCallLog.count({ where: { id: { in: [kept, recent] } } })).toBe(2);
        expect(await prisma.aiSpendMonth.findMany({ where: { workspaceId: account.workspaceId }, take: 50 })).toEqual(months);
    });

    it('a retention set below the floor is read as the floor', async () => {
        const young = await oldCall(RETENTION_FLOOR_DAYS - 10);
        await purgeExpiredAiCallLogs({ days: 30 });
        expect(await prisma.aiCallLog.count({ where: { id: young } })).toBe(1);
    });
});
