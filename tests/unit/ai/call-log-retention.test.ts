/**
 * The call log's retention (Phase 2.H, issue #30 item 4): a conservative
 * default, a floor no configuration passes (the database holds the same one),
 * and production refuses a malformed value.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_RETENTION_DAYS, parseRetentionDays, RETENTION_FLOOR_DAYS, retentionConfigProblems, retentionCutoff, retentionDays } from '@/lib/ai/call-log-retention';
import { productionConfigProblems } from '@/lib/startup-checks';

it('defaults to 400 days, and never reads below the floor', () => {
    expect(retentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBeGreaterThanOrEqual(RETENTION_FLOOR_DAYS);
    expect(parseRetentionDays('365')).toBe(365);
    expect(parseRetentionDays('30')).toBeNull();
    expect(parseRetentionDays('1e3')).toBeNull();
    expect(retentionDays('30')).toBe(DEFAULT_RETENTION_DAYS);
    const now = new Date('2026-11-20T00:00:00Z');
    expect(retentionCutoff(now, 30).getTime()).toBe(now.getTime() - RETENTION_FLOOR_DAYS * 86_400_000);
});

it('production refuses a value below the floor or malformed', () => {
    expect(retentionConfigProblems('30')).toHaveLength(1);
    expect(retentionConfigProblems('400')).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: 'production', AI_CALL_LOG_RETENTION_DAYS: '90' }).some((p) => p.startsWith('AI_CALL_LOG_RETENTION_DAYS'))).toBe(true);
});

it('the floor in code is the floor in the trigger', () => {
    const dir = path.resolve(__dirname, '../../../prisma/migrations');
    const latest = fs
        .readdirSync(dir)
        .filter((d) => fs.existsSync(path.join(dir, d, 'migration.sql')) && fs.readFileSync(path.join(dir, d, 'migration.sql'), 'utf8').includes('FUNCTION ai_call_log_append_only'))
        .sort()
        .pop()!;
    const sql = fs.readFileSync(path.join(dir, latest, 'migration.sql'), 'utf8');
    expect(sql).toContain(`interval '${RETENTION_FLOOR_DAYS} days'`);
});
