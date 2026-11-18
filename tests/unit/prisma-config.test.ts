/**
 * prisma.config.ts gives the Prisma CLI a connection URL from `.env`.
 *
 * Prisma 7's CLI loads no env file, so without the config loading one,
 * `npm run db:migrate` after the README's `cp .env.example .env` fails with
 * "Connection url is empty". These cases load the real config module from a
 * scratch directory holding only a `.env`, as the CLI would see it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CONFIG = path.resolve(__dirname, '../../prisma.config.ts');
const KEYS = ['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const;

type ConfigModule = typeof import('../../prisma.config');

/** Load prisma.config.ts afresh with `cwd` as the working directory. */
function loadConfigIn(cwd: string): ConfigModule {
    const before = process.cwd();
    process.chdir(cwd);
    try {
        let mod: ConfigModule | undefined;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            mod = require(CONFIG) as ConfigModule;
        });
        return mod!;
    } finally {
        process.chdir(before);
    }
}

describe('prisma.config.ts', () => {
    const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-prisma-config-'));
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the URL from .env when nothing is exported', () => {
        fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgresql://u:p@localhost:5433/from_dotenv\n');
        const config = loadConfigIn(dir).default;
        expect(config.datasource?.url).toBe('postgresql://u:p@localhost:5433/from_dotenv');
    });

    it('prefers DIRECT_DATABASE_URL from .env for migrations', () => {
        fs.writeFileSync(
            path.join(dir, '.env'),
            'DATABASE_URL=postgresql://u:p@localhost:5433/pooled\nDIRECT_DATABASE_URL=postgresql://u:p@localhost:5436/direct\n',
        );
        expect(loadConfigIn(dir).default.datasource?.url).toBe('postgresql://u:p@localhost:5436/direct');
    });

    it('an exported variable wins over .env', () => {
        fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgresql://u:p@localhost:5433/from_dotenv\n');
        process.env.DATABASE_URL = 'postgresql://u:p@localhost:5433/exported';
        expect(loadConfigIn(dir).default.datasource?.url).toBe('postgresql://u:p@localhost:5433/exported');
    });

    it('no .env and nothing exported is an empty URL, not an error (postinstall generate)', () => {
        expect(loadConfigIn(dir).default.datasource?.url).toBe('');
    });

    it('an empty DIRECT_DATABASE_URL falls back to DATABASE_URL', () => {
        const { datasourceUrl } = loadConfigIn(dir);
        expect(datasourceUrl({ DIRECT_DATABASE_URL: '', DATABASE_URL: 'postgresql://x' })).toBe('postgresql://x');
        expect(datasourceUrl({})).toBe('');
    });
});
