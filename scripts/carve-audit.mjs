/**
 * The carve-manifest audit (roadmap rule 7, Phase 0.H): every file whose
 * content matches an inflect-compliance file must be listed in
 * docs/carve-manifest.md. `tests/unit/carve-manifest.test.ts` checks the
 * other direction (every listed file exists) on every run; this direction
 * needs an inflect-compliance checkout, which CI does not have, so it is run
 * by hand at each hardening subphase and its result recorded in that
 * subphase's implementation note.
 *
 *   node scripts/carve-audit.mjs <path to inflect-compliance> [commit]
 *
 * For every file git lists here (tracked and untracked, not ignored, not
 * deleted; lockfiles skipped), it reports a file that is
 *   EXACT    byte-identical to a blob in inflect's tree at `commit`, or
 *   SIMILAR  sharing at least `THRESHOLD` of its distinctive lines (30+
 *            characters, not an import or a comment) with one inflect file,
 *            found through an index of every inflect source file's lines,
 * and is not in the manifest's first column. Exit 1 when there is one.
 * Lines that occur in more than 20 inflect files are boilerplate and count
 * for nothing. An empty file matches every empty file and is not reported.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD = 0.3;
const TEXT = /\.(ts|tsx|js|mjs|cjs|sql|prisma|sh|css|json|md|ya?ml)$/;

const [inflect, commit = '5528464fc54a8681956f3b9ce23ca9c075f0420e'] = process.argv.slice(2);
if (!inflect) {
    process.stderr.write('usage: node scripts/carve-audit.mjs <inflect-compliance checkout> [commit]\n');
    process.exit(2);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const lines = (s) => s.split('\n').filter(Boolean);
const distinctive = (text) =>
    new Set(
        text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length >= 30 && !/^(import |\/\/|\*|\/\*)/.test(l)),
    );
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// inflect's tree at the commit: blob shas, and a line index of its text files.
const blobs = new Map();
const index = new Map();
for (const entry of lines(git(inflect, 'ls-tree', '-r', commit))) {
    const [meta, file] = entry.split('\t');
    const sha = meta.split(' ')[2];
    blobs.set(sha, file);
    if (!TEXT.test(file) || file.includes('node_modules/')) continue;
    let text;
    try {
        text = git(inflect, 'cat-file', 'blob', sha);
    } catch {
        continue;
    }
    if (text.length > 400_000) continue;
    for (const l of distinctive(text)) {
        if (!index.has(l)) index.set(l, new Set());
        index.get(l).add(file);
    }
}

const manifest = fs.readFileSync(path.join(ROOT, 'docs/carve-manifest.md'), 'utf8');
const listed = new Set([...manifest.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
const deleted = new Set(lines(git(ROOT, 'ls-files', '--deleted')));
const files = lines(git(ROOT, 'ls-files', '-co', '--exclude-standard')).filter(
    (f) => !deleted.has(f) && !f.endsWith('package-lock.json') && fs.existsSync(path.join(ROOT, f)),
);

const unlisted = [];
for (const file of files) {
    if (listed.has(file)) continue;
    const buf = fs.readFileSync(path.join(ROOT, file));
    if (buf.length === 0) continue;
    if (blobs.has(blobSha(buf))) {
        unlisted.push(`EXACT    ${file} <- ${blobs.get(blobSha(buf))}`);
        continue;
    }
    if (!TEXT.test(file)) continue;
    const mine = distinctive(buf.toString('utf8'));
    if (mine.size < 4) continue;
    const counts = new Map();
    for (const l of mine) {
        const where = index.get(l);
        if (!where || where.size > 20) continue;
        for (const f of where) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (best && n / mine.size >= THRESHOLD) unlisted.push(`SIMILAR  ${file} <- ${best} (${n}/${mine.size} lines)`);
}

const missing = [...listed].filter((f) => !fs.existsSync(path.join(ROOT, f)));
process.stdout.write(`${files.length} files audited against ${commit}\n`);
for (const u of unlisted) process.stdout.write(`unlisted: ${u}\n`);
for (const m of missing) process.stdout.write(`listed but missing: ${m}\n`);
process.exit(unlisted.length > 0 || missing.length > 0 ? 1 : 0);
