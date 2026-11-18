/**
 * The Prisma client built by src/lib/db.ts reaches a real PostgreSQL through
 * the driver adapter.
 *
 * DATABASE_URL names the database: CI's Test job starts a postgres:16
 * service and exports it; locally jest.setup.js falls back to the
 * documented `inkquisitor_test` database (README.md). There is deliberately
 * no skip when the database is unreachable — a smoke test that passes
 * without a database proves nothing.
 */
import { createPrismaClient } from '@/lib/db';

const url = process.env.DATABASE_URL;

describe('database smoke', () => {
    if (!url) {
        it('needs DATABASE_URL', () => {
            throw new Error('DATABASE_URL is not set; the integration project runs against a real PostgreSQL.');
        });
        return;
    }

    const client = createPrismaClient(url);
    afterAll(() => client.$disconnect());

    it('runs a query through the adapter', async () => {
        const rows = await client.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
        expect(rows).toEqual([{ one: 1 }]);
    });

    it('talks to PostgreSQL 16 or later', async () => {
        const rows = await client.$queryRaw<{ server_version_num: string }[]>`SHOW server_version_num`;
        expect(Number(rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
    });
});
