/**
 * `AiCallLog.errorCode` is a closed vocabulary twice: `AI_ERROR_CODES` in
 * code and the `AiCallLog_errorCode_known` CHECK in the migration. A code the
 * layer can record but the CHECK refuses makes that call's settlement fail
 * (the record and the month's spend lost together), so the two lists must be
 * the same set.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { AI_ERROR_CODES } from '@/lib/ai/errors';

it('the CHECK names exactly AI_ERROR_CODES', () => {
    const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261119500000_ai_model_layer/migration.sql'), 'utf8');
    const check = /ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK \("errorCode" IS NULL OR "errorCode" IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const inCheck = [...check![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...AI_ERROR_CODES].sort());
});
