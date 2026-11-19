/**
 * The PDF's font files (issue #24): Noto Sans 2.015, regular and bold, under
 * the SIL Open Font License, committed at the bytes recorded here and in
 * NOTICE, and present wherever the app runs:
 *
 * - in the repository, so `next start` (the E2E server), the worker and the
 *   tests, all run from the root, read them from `<cwd>/fonts/noto-sans`;
 * - in the image: the runner stage copies `fonts/` into its working
 *   directory. The last test lays a directory out as that stage does (every
 *   `COPY --from=builder` it makes that the checkout holds) and loads the
 *   fonts from there, so dropping the COPY fails it.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fontkit from 'fontkit';
import { PDF_FONT_DIR, PDF_FONT_FILES } from '@/lib/pdf/fonts';
import { repoRelativeFiles, REPO_ROOT } from '../../helpers/repo-files';

/** The pinned files: notofonts.github.io at ebbf5a34c2aaac39770e02d24afcfe9a8ad55e3e, fonts/NotoSans/unhinted/ttf/. */
const PINNED: Readonly<Record<string, string>> = {
    'NotoSans-Regular.ttf': 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
    'NotoSans-Bold.ttf': '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
};

const dir = path.join(REPO_ROOT, PDF_FONT_DIR);
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('the committed font files', () => {
    it('are the pinned Noto Sans 2.015 files, regular and bold, and nothing else is loaded', () => {
        expect(Object.values(PDF_FONT_FILES).sort()).toEqual(Object.keys(PINNED).sort());
        for (const [file, hash] of Object.entries(PINNED)) {
            expect([file, sha256(path.join(dir, file))]).toEqual([file, hash]);
            const font = fontkit.create(fs.readFileSync(path.join(dir, file)));
            expect('version' in font && font.version).toBe('Version 2.015');
        }
    });

    it('are tracked by git with the OFL beside them, and NOTICE credits them', () => {
        const tracked = new Set(repoRelativeFiles());
        for (const file of [...Object.keys(PINNED), 'OFL.txt']) expect([file, tracked.has(`${PDF_FONT_DIR}/${file}`)]).toEqual([file, true]);
        const ofl = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
        expect(ofl).toContain('Copyright 2022 The Noto Project Authors');
        expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
        const notice = fs.readFileSync(path.join(REPO_ROOT, 'NOTICE'), 'utf8');
        expect(notice).toContain('SIL Open Font License');
        expect(notice).toContain('Noto Sans');
        for (const hash of Object.values(PINNED)) expect(notice).toContain(hash);
    });
});

describe('the fonts at run time', () => {
    it('pdfkit and fontkit are loaded from node_modules, not bundled', () => {
        const config = fs.readFileSync(path.join(REPO_ROOT, 'next.config.mjs'), 'utf8');
        const list = config.slice(config.indexOf('serverExternalPackages'), config.indexOf('],', config.indexOf('serverExternalPackages')));
        expect(list).toContain("'pdfkit'");
        expect(list).toContain("'fontkit'");
    });

    it('nothing keeps fonts/ out of the image build context', () => {
        const ignored = fs
            .readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '' && !l.startsWith('#'));
        expect(ignored.filter((l) => l === '*' || /^\/?(\*\*\/)?fonts(\/|$)/.test(l))).toEqual([]);
    });

    it('load from a directory laid out as the image’s runner stage lays out /app', () => {
        const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
        const runner = dockerfile.slice(dockerfile.indexOf('AS runner'));
        expect(runner).toMatch(/^WORKDIR \/app$/m);
        // The entrypoint starts `next start` in the working directory.
        expect(fs.readFileSync(path.join(REPO_ROOT, 'scripts/entrypoint.sh'), 'utf8')).not.toMatch(/^\s*cd\s/m);

        const app = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-fonts-app-'));
        const cwd = process.cwd();
        try {
            for (const m of runner.matchAll(/^COPY --from=builder \/app\/(\S+) (\S+)$/gm)) {
                const from = path.join(REPO_ROOT, m[1]);
                // Build outputs (.next, dist, node_modules) are not in a checkout's tree as files the test needs.
                if (!fs.existsSync(from) || ['.next', 'dist', 'node_modules'].includes(m[1])) continue;
                fs.cpSync(from, path.resolve(app, m[2]), { recursive: true });
            }
            process.chdir(app);
            jest.isolateModules(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module, read from the new working directory
                const { createPdfDocument } = require('@/lib/pdf/pdfKitFactory') as typeof import('@/lib/pdf/pdfKitFactory');
                const doc = createPdfDocument({ workspaceName: 'w', reportTitle: 't', generatedAt: '2026-11-19T10:00:00.000Z' });
                doc.text('Ж');
                doc.end();
            });
        } finally {
            process.chdir(cwd);
            fs.rmSync(app, { recursive: true, force: true });
        }
    });
});
