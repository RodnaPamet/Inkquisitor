/**
 * Two ways a developer's machine leaks what the dev stack holds.
 *
 *   • docker-compose.yml publishes a port on every interface unless it names
 *     a host address, and Docker's iptables rules bypass host firewalls. The
 *     stack's credentials are well known (Postgres superuser
 *     `postgres`/`postgres`), so every published port is loopback-only.
 *   • .gitignore must ignore every env file but the committed template:
 *     `next dev` loads `.env.development`, a natural home for a real secret.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Each item of a `ports:` list in docker-compose.yml. */
function publishedPorts(): string[] {
    const lines = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8').split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const header = /^(\s*)ports:\s*$/.exec(lines[i]);
        if (!header) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const item = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[j]);
            if (!item) break;
            out.push(item[1]);
        }
    }
    return out;
}

function isIgnored(file: string): boolean {
    try {
        execFileSync('git', ['check-ignore', '--no-index', '-q', file], { cwd: ROOT, stdio: 'ignore' });
        return true;
    } catch (err) {
        if ((err as { status?: number }).status === 1) return false;
        throw err;
    }
}

describe('dev stack hygiene', () => {
    it('docker-compose.yml publishes ports (so the next check reads something)', () => {
        expect(publishedPorts().length).toBeGreaterThanOrEqual(4);
    });

    it('every published port is bound to 127.0.0.1', () => {
        expect(publishedPorts().filter((p) => !p.startsWith('127.0.0.1:'))).toEqual([]);
    });

    it.each(['.env', '.env.local', '.env.development', '.env.dev', '.env.prod', '.env.production', '.env.test'])(
        '%s is ignored by git',
        (file) => {
            expect(isIgnored(file)).toBe(true);
        },
    );

    it('.env.example, the committed template, is not ignored', () => {
        expect(isIgnored('.env.example')).toBe(false);
    });
});
