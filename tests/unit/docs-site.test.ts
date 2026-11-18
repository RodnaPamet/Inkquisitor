/**
 * The help site publishes docs/user/ and nothing else.
 *
 * Runs the stager's own policy (`site/scripts/stage-docs.js`) over the real
 * manifest and the real files, then over planted manifests that try to
 * publish the roadmap, an implementation note or a doc outside docs/user/,
 * each of which must be refused. And the deploy is guarded so a repository
 * without GitHub Pages does not fail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// CommonJS, no dependencies, so it is required as-is.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stage = require('../../site/scripts/stage-docs.js');

const ROOT = path.resolve(__dirname, '../..');

describe('the real manifest', () => {
    it('is publishable, and its landing page is docs/user/index.md', () => {
        const manifest = stage.readManifest();
        expect(stage.publicationRefusals(manifest, stage.readRepoFile, stage.listRepoFolder)).toEqual([]);
        const docs: string[] = stage.publishedDocs(manifest, stage.listRepoFolder);
        expect(docs[0]).toBe('docs/user/index.md');
        expect(docs.every((d) => d.startsWith('docs/user/'))).toBe(true);
        expect(fs.readFileSync(path.join(ROOT, 'docs/user/index.md'), 'utf8')).toMatch(/^# What Inkquisitor is$/m);
    });
});

describe('the policy refuses', () => {
    const read = (p: string) => (p.startsWith('docs/') ? '# T\n\nbody' : null);
    const list = () => ['docs/user/a.md'];

    it.each([
        ['the roadmap', 'docs/ROADMAP.md'],
        ['an implementation note', 'docs/implementation-notes/2026-11-18-0.4-platform-services.md'],
        ['the carve manifest', 'docs/carve-manifest.md'],
        ['CLAUDE.md', 'CLAUDE.md'],
        ['a folder outside docs/user/', 'docs/'],
    ])('%s', (_name, entry) => {
        const refusals = stage.publicationRefusals({ sections: [{ label: 'X', docs: [entry] }] }, read, list);
        expect(refusals.join('\n')).toMatch(/publishes only plain paths under docs\/user\//);
    });

    it.each([
        ['a dot-dot walk to the roadmap', 'docs/user/../ROADMAP.md'],
        ['a dot-dot walk to a note', 'docs/user/../implementation-notes/2026-11-18-0.4-platform-services.md'],
        ['a walk out of the repository', 'docs/user/../../../etc/passwd'],
        ['a dot segment', 'docs/user/./a.md'],
        ['an empty segment', 'docs/user//a.md'],
        ['a backslash', 'docs/user\\..\\ROADMAP.md'],
        ['an absolute path', '/docs/user/a.md'],
        ['a dot-dot folder', 'docs/user/../'],
    ])('%s, even though it starts with docs/user/', (_name, entry) => {
        const reads: string[] = [];
        const readSpy = (p: string) => {
            reads.push(p);
            return read(p);
        };
        const refusals = stage.publicationRefusals({ sections: [{ label: 'X', docs: [entry] }] }, readSpy, list);
        expect(refusals.join('\n')).toMatch(/publishes only plain paths under docs\/user\//);
        // A refused entry is never read.
        expect(reads).not.toContain(entry);
        expect(stage.entryShapeRefusal(entry)).not.toBeNull();
    });

    it('NEVER_PUBLISH is matched on the normalised path', () => {
        expect(stage.neverPublishReason('docs/user/../ROADMAP.md')).toMatch(/roadmap/);
    });

    it('never writes a page outside the content folder', () => {
        const dir = path.join(ROOT, 'site/src/content/docs');
        expect(stage.outputPathFor('docs/user/how-to/x.md', dir)).toBe(path.join(dir, 'how-to/x.md'));
        expect(() => stage.outputPathFor('docs/user/../roadmap.md', dir)).toThrow(/outside/);
    });

    it('a symbolic link is not read, whatever it points at', () => {
        // Under a gitignored `build/` folder, so no source scan running in
        // parallel ever lists the planted link.
        const linkDir = path.join(ROOT, 'docs/user/build', `link-${process.pid}`);
        fs.mkdirSync(linkDir, { recursive: true });
        const link = path.join(linkDir, 'page.md');
        fs.symlinkSync(path.join(ROOT, 'docs/ROADMAP.md'), link);
        try {
            expect(stage.readRepoFile(path.relative(ROOT, link).split(path.sep).join('/'))).toBeNull();
            expect(stage.readRepoFile('docs/user/index.md')).toMatch(/^# /m);
        } finally {
            fs.rmSync(path.join(ROOT, 'docs/user/build'), { recursive: true, force: true });
        }
    });

    it('a published doc that carries a credentialed URL', () => {
        const refusals = stage.publicationRefusals(
            { sections: [] },
            () => '# T\n\nREDIS_URL=redis://:hunter2@cache:6379',
            list,
        );
        expect(refusals.join('\n')).toMatch(/redis-password/);
    });

    it('a missing landing page', () => {
        expect(stage.publicationRefusals({ sections: [] }, () => null, list).join('\n')).toMatch(/index\.md: does not exist/);
    });

    it('a manifest with no sections array', () => {
        expect(stage.publicationRefusals({}, read, list)).toEqual(['the manifest has no "sections" array']);
    });
});

describe('page staging', () => {
    it('lifts the title into frontmatter and rewrites links by what they point at', () => {
        const out: string = stage.stagePage(
            '# Getting going\n\nSee [the bible](guide/bible.md), [the roadmap](../ROADMAP.md) and [the code](../../src/lib/db.ts).',
            'docs/user/index.md',
            new Set(['docs/user/index.md', 'docs/user/guide/bible.md']),
        );
        expect(out).toMatch(/^---\ntitle: "Getting going"\n---/);
        expect(out).toContain(`[the bible](${stage.SITE_BASE}/guide/bible/)`);
        // An unpublished doc becomes plain text, never a link.
        expect(out).toContain(' the roadmap ');
        expect(out).toContain('[the code](https://github.com/RodnaPamet/Inkquisitor/blob/main/src/lib/db.ts)');
    });
});

describe('.github/workflows/docs-site.yml', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/docs-site.yml'), 'utf8');

    it('builds on pull requests touching docs or the site', () => {
        expect(wf).toMatch(/pull_request:\n {4}paths:\n {6}- 'docs\/\*\*'\n {6}- 'site\/\*\*'/);
    });

    it('deploys only on main and only when Pages is enabled', () => {
        const deploy = wf.slice(wf.indexOf('\n  deploy:'));
        expect(deploy).toMatch(/if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request' && github\.event\.repository\.has_pages/);
        expect(deploy).toMatch(/pages: write/);
        expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
    });
});
