/**
 * Decision D13 (2026-11-20), "Interview E2E against the production build": a
 * loopback-only model stub, with structural pack evaluation records accepted
 * ONLY in that mode. The full matrix — NODE_ENV × stub × loopback × record
 * kind — through the real mount gate on a shipped pack, and the start-up
 * check that holds any structural mode to a loopback test server.
 *
 * D11 must not move: production without the loopback stub mounts only a real
 * model's record, whatever else the environment says.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPacks, getPacks, PACKS_DIR, PACK_RECORD_FILE } from '@/lib/interview/packs';
import { checkPackMountable, packRecordModeOf, type PackEnvRecord } from '@/lib/interview/pack-mount';
import { evaluatePack } from '@/lib/interview/pack-evaluation';
import { loopbackStubMode } from '@/lib/ai/model-stub';
import { productionConfigProblems, productionConfigWarnings } from '@/lib/startup-checks';
import { fakeGenerator } from '../../helpers/fake-question-generator';

const NAME = 'craft-character';
const packs = getPacks();
let modelRegistry: ReturnType<typeof loadPacks>;
let dir: string;

beforeAll(async () => {
    // The same pack with a real model's record in place of the structural one (a model's own wording).
    const reworded = fakeGenerator({ mutate: (q) => ({ ...q, text: q.text.replace(/\?$/, ', as you see it?'), rationale: `${q.rationale} (model)` }) });
    const { record } = await evaluatePack(packs, NAME, reworded, { kind: 'model', id: 'claude-sonnet-5-5' }, new Date(0));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-d13-'));
    fs.cpSync(PACKS_DIR, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'craft/character', PACK_RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
    modelRegistry = loadPacks(dir);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const ENVS = ['production', 'development', 'test'] as const;
const STUBS = { unset: undefined, on: '1', off: '0', other: 'yes' } as const;
const HOSTS: Record<string, { APP_URL?: string; NEXTAUTH_URL?: string; loopback: boolean }> = {
    'both localhost': { APP_URL: 'http://localhost:3332', NEXTAUTH_URL: 'http://localhost:3332', loopback: true },
    'both 127.0.0.1': { APP_URL: 'http://127.0.0.1:3332', NEXTAUTH_URL: 'http://127.0.0.1:3332', loopback: true },
    'both [::1]': { APP_URL: 'http://[::1]:3332', NEXTAUTH_URL: 'http://[::1]:3332', loopback: true },
    'a real host': { APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'https://inkquisitor.example', loopback: false },
    'APP_URL only': { APP_URL: 'http://localhost:3332', NEXTAUTH_URL: 'https://inkquisitor.example', loopback: false },
    'NEXTAUTH_URL only': { APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'http://localhost:3332', loopback: false },
    'APP_URL unset': { NEXTAUTH_URL: 'http://localhost:3332', loopback: false },
    'localhost.evil.com': { APP_URL: 'http://localhost.evil.com', NEXTAUTH_URL: 'http://localhost.evil.com', loopback: false },
    'userinfo trick': { APP_URL: 'http://localhost@evil.example', NEXTAUTH_URL: 'http://127.0.0.1@evil.example', loopback: false },
    '127.0.0.1.nip.io': { APP_URL: 'http://127.0.0.1.nip.io', NEXTAUTH_URL: 'http://127.0.0.1.nip.io', loopback: false },
    'IPv4-mapped IPv6': { APP_URL: 'http://[::ffff:127.0.0.1]', NEXTAUTH_URL: 'http://[::ffff:127.0.0.1]', loopback: false },
};
const KEYS = { 'no key': undefined, 'a provider key': 'sk-ant-real-key' } as const;

type Case = [string, string, string, string, PackEnvRecord, boolean];
const cases: Case[] = [];
for (const NODE_ENV of ENVS)
    for (const [stubName, AI_MODEL_STUB] of Object.entries(STUBS))
        for (const [hostName, host] of Object.entries(HOSTS))
            for (const [keyName, ANTHROPIC_API_KEY] of Object.entries(KEYS)) {
                const loopbackStub = AI_MODEL_STUB === '1' && host.loopback && ANTHROPIC_API_KEY === undefined;
                cases.push([NODE_ENV, stubName, hostName, keyName, { NODE_ENV, AI_MODEL_STUB, ANTHROPIC_API_KEY, APP_URL: host.APP_URL, NEXTAUTH_URL: host.NEXTAUTH_URL }, NODE_ENV !== 'production' || loopbackStub]);
            }

describe('which records mount a pack (D11, D13)', () => {
    it.each(cases)('%s, stub %s, %s, %s', async (nodeEnv, _stub, _host, _key, e, structuralAccepted) => {
        const mode = packRecordModeOf(e);
        expect(mode).toBe(structuralAccepted ? 'structural' : 'model');
        // The loopback-stub mode is exactly the stub on, no key, both addresses loopback.
        if (nodeEnv === 'production') expect(loopbackStubMode(e)).toBe(structuralAccepted);
        // Record kind: a structural record mounts only where structural is accepted; a model's record mounts everywhere.
        expect((await checkPackMountable(packs.files[NAME], packs, mode)).ok).toBe(structuralAccepted);
        expect(await checkPackMountable(modelRegistry.files[NAME], modelRegistry, mode)).toMatchObject({ ok: true, pin: { recordKind: 'model' } });
    });

    it('production without the loopback stub is model mode, whatever else is set (D11 holds)', () => {
        for (const extra of [{}, { INTERVIEW_PACK_RECORDS: 'structural' }, { AI_MODEL_STUB: '1' }, { AI_MODEL_STUB: '1', APP_URL: 'http://localhost' }]) {
            expect(packRecordModeOf({ NODE_ENV: 'production', ...extra } as PackEnvRecord)).toBe('model');
        }
    });
});

const longValue = (seed: string) => `${seed}-`.repeat(8);
const PROD = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ink',
    REDIS_URL: 'redis://:pw@redis:6379',
    CLAMAV_HOST: 'clamav:3310',
    FILE_STORAGE_ROOT: '/var/lib/inkquisitor/uploads',
    AUTH_SECRET: longValue('auth'),
    DATA_ENCRYPTION_KEY: longValue('kek'),
};

describe('the start-up check (D13): a real deployment can use neither the stub nor structural records', () => {
    it.each(Object.entries(HOSTS).filter(([, h]) => !h.loopback))('production with the stub and %s refuses to start, naming the stub', (_name, host) => {
        const problems = productionConfigProblems({ ...PROD, AI_MODEL_STUB: '1', APP_URL: host.APP_URL, NEXTAUTH_URL: host.NEXTAUTH_URL });
        expect(problems.some((p) => p.includes('AI_MODEL_STUB'))).toBe(true);
    });

    it('a loopback stub server starts, warning at every start that it runs the stub and accepts structural records', () => {
        const env = { ...PROD, AI_MODEL_STUB: '1', APP_URL: 'http://127.0.0.1:3332', NEXTAUTH_URL: 'http://127.0.0.1:3332' };
        expect(productionConfigProblems(env)).toEqual([]);
        const warnings = productionConfigWarnings(env);
        expect(warnings.some((w) => w.includes('AI_MODEL_STUB=1'))).toBe(true);
        expect(warnings.some((w) => w.includes('STRUCTURAL evaluation records') && w.includes('D13'))).toBe(true);
        // A real deployment says nothing about structural records: it never accepts them.
        expect(productionConfigWarnings({ ...PROD, ANTHROPIC_API_KEY: longValue('k'), AI_RETENTION_MODE: 'zdr', APP_URL: 'https://inkquisitor.example', NEXTAUTH_URL: 'https://inkquisitor.example' }).some((w) => w.includes('STRUCTURAL'))).toBe(false);
    });
});
