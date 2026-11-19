/**
 * `AiCallLog.errorCode` is a closed vocabulary twice: `AI_ERROR_CODES` in
 * code and the `AiCallLog_errorCode_known` CHECK in the migration. A code the
 * layer can record but the CHECK refuses makes that call's settlement fail
 * (the record and the month's spend lost together), so the two lists must be
 * the same set.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { AI_ERROR_CODES } from '@/lib/ai/errors';

const CHECK = /ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK/;

/** The migration that defines the CHECK last: the one the database holds. */
function latestDefinition(): string {
    const dir = path.join(process.cwd(), 'prisma/migrations');
    const defining = readdirSync(dir)
        .filter((name) => /^\d{14}_/.test(name))
        .sort()
        .map((name) => readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'))
        .filter((sql) => CHECK.test(sql));
    expect(defining.length).toBeGreaterThan(0);
    return defining[defining.length - 1];
}

it('the CHECK the latest migration defines names exactly AI_ERROR_CODES', () => {
    const sql = latestDefinition();
    const check = /ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK \("errorCode" IS NULL OR "errorCode" IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const inCheck = [...check![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...AI_ERROR_CODES].sort());
});
