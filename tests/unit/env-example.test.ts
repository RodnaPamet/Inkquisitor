/**
 * Every environment variable the application reads through src/env.ts or
 * src/env-client.ts is listed in .env.example, and .env.example lists none
 * that nothing reads.
 *
 * The keys are read from each module's `runtimeEnv` block, which t3-env
 * requires to name every variable by hand.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function runtimeEnvKeys(file: string): string[] {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const block = /runtimeEnv:\s*\{([^}]*)\}/.exec(src);
    if (!block) throw new Error(`${file}: no runtimeEnv block found`);
    return [...block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

function exampleKeys(): string[] {
    const src = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    return [...src.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

/** Variables read outside the env modules, by tools that are not Next. */
const READ_BY_TOOLING = ['DIRECT_DATABASE_URL']; // prisma.config.ts

describe('.env.example', () => {
    const declared = [...runtimeEnvKeys('src/env.ts'), ...runtimeEnvKeys('src/env-client.ts')];

    it('the server env module declares the variables the skeleton reads', () => {
        expect(declared).toEqual(expect.arrayContaining(['NODE_ENV', 'DATABASE_URL']));
    });

    it('lists every variable the env modules read', () => {
        const listed = new Set(exampleKeys());
        expect(declared.filter((k) => !listed.has(k))).toEqual([]);
    });

    it('lists nothing that no code reads', () => {
        const read = new Set([...declared, ...READ_BY_TOOLING]);
        expect(exampleKeys().filter((k) => !read.has(k))).toEqual([]);
    });
});
