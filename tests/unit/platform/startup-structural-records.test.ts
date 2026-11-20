/**
 * D13's start-up backstop: whatever `packRecordModeOf` says, a production
 * process that would mount packs on STRUCTURAL records with a real host
 * refuses to start, naming it. The rule is replaced here by one that says
 * "structural" everywhere, which no shipped configuration can do: the check
 * must hold on its own.
 */
jest.mock('@/lib/interview/pack-records-config', () => ({ ...jest.requireActual('@/lib/interview/pack-records-config'), packRecordModeOf: () => 'structural' }));

import { enforceProductionConfig } from '@/lib/startup-checks';

const longValue = (seed: string) => `${seed}-`.repeat(8);
const PROD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ink',
    REDIS_URL: 'redis://:pw@redis:6379',
    CLAMAV_HOST: 'clamav:3310',
    FILE_STORAGE_ROOT: '/var/lib/inkquisitor/uploads',
    AUTH_SECRET: longValue('auth'),
    DATA_ENCRYPTION_KEY: longValue('kek'),
    ANTHROPIC_API_KEY: longValue('key'),
    AI_RETENTION_MODE: 'zdr',
};

it('production accepting structural records beside a real host exits 1, naming it', () => {
    const lines: string[] = [];
    const exit = jest.fn();
    enforceProductionConfig({ ...PROD, APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'https://inkquisitor.example' }, (l) => lines.push(l), exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.some((l) => l.startsWith('[startup] FATAL: ') && l.includes('structural evaluation records') && l.includes('D13'))).toBe(true);
});

it('on a loopback test server it starts, and says so', () => {
    const lines: string[] = [];
    const exit = jest.fn();
    enforceProductionConfig({ ...PROD, APP_URL: 'http://localhost:3332', NEXTAUTH_URL: 'http://localhost:3332' }, (l) => lines.push(l), exit);
    expect(exit).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('[startup] WARN: ') && l.includes('STRUCTURAL'))).toBe(true);
});
