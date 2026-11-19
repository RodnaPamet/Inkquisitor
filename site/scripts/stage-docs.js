'use strict';
/**
 * Stage the published docs into the help site (site/src/content/docs/).
 *
 * ONE site, for people who USE Inkquisitor, and it publishes only
 * `docs/user/`. Its `manifest.json` is an ALLOWLIST: `docs/user/index.md`
 * (the landing page, "What Inkquisitor is") is always published, and any
 * other page only when a section lists it. A new doc is therefore unpublished
 * until somebody decides otherwise — the fail-closed direction.
 *
 * Two policies are enforced HERE, in the step that writes what gets
 * published, and the build stops on either:
 *   - a listed doc outside `docs/user/`, or one in NEVER_PUBLISH (the
 *     roadmap, the carve manifest, the implementation notes, CLAUDE.md);
 *   - FORBIDDEN_CONTENT: a published doc carrying an operator coordinate.
 *
 * WHAT EXCLUSION DOES NOT MEAN. If the repository is public, every file in
 * `docs/` is readable on github.com already. Keeping a doc off the site keeps
 * it out of the site's navigation and search; it is not confidentiality, and
 * a secret never belongs in `docs/` at all (`.secret-patterns` holds that).
 *
 * Links between published docs become site links; a link to an unpublished
 * doc becomes its label as plain text, so the site never routes a reader to a
 * page that was kept off it; a link to any other repository file goes to
 * github.com.
 *
 * CommonJS with no dependencies: CI runs it with bare `node`, and the root
 * Jest suite requires it to test the pure functions directly
 * (tests/unit/docs-site.test.ts).
 *
 * Adapted from inflect-compliance's `site/scripts/stage-docs.js` (two sites,
 * UI-label tokens, route checks and generated reference pages are not
 * carried: there is one help site and, so far, one page).
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'RodnaPamet/Inkquisitor';
const GITHUB = `https://github.com/${REPO}`;
/** The project site's base path: rodnapamet.github.io/<repo>/. */
const SITE_BASE = '/Inkquisitor';
const SITE_TITLE = 'Inkquisitor Help';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE_DIR = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(SITE_DIR, 'src', 'content', 'docs');

/** Everything the site publishes lives under this folder. */
const PUBLISHED_FOLDER = 'docs/user/';
const LANDING_PAGE = 'docs/user/index.md';

/** Kept off the site by name, whatever a manifest says. An entry ending in `/` covers its folder. */
const NEVER_PUBLISH = Object.freeze({
    'docs/ROADMAP.md': 'the internal product roadmap',
    'docs/carve-manifest.md': 'the internal carve record',
    'docs/implementation-notes/': 'internal engineering notes',
    'CLAUDE.md': 'contributor and assistant guidance',
    'README.md': 'the repository readme',
});

/** Coordinates of an operator's estate that a public page must never carry. */
const FORBIDDEN_CONTENT = Object.freeze([
    { id: 'env-file', re: /\.env\.(prod|production|staging)\b/, why: 'a deployment secrets file' },
    { id: 'redis-password', re: /rediss?:\/\/[^\s:@/]*:[^\s@/]+@/, why: 'a Redis URL with a password' },
    { id: 'postgres-password', re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@(?!localhost)/, why: 'a database URL with credentials' },
]);

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** `docs/user/how-to/x.md` → `how-to/x`; the landing page → `index`. */
function slugFor(repoPath) {
    return repoPath.replace(/^docs\/user\//, '').replace(/\.md$/i, '').toLowerCase();
}

const isFolderEntry = (entry) => entry.endsWith('/');

/**
 * Why a manifest entry's SHAPE is refused, or null. An entry is a plain
 * repository path under `docs/user/`: no `..` or `.` segment, no empty
 * segment, no backslash, no absolute path, and already in normal form — so
 * the string the policy checks is the path the build reads and writes.
 * (`docs/user/../ROADMAP.md` starts with `docs/user/` and names the roadmap.)
 */
function entryShapeRefusal(entry) {
    if (typeof entry !== 'string' || entry === '') return 'is not a path';
    if (entry.includes('\\') || entry.includes('\0')) return 'carries a backslash or a NUL';
    if (entry.startsWith('/')) return 'is absolute';
    const segments = (isFolderEntry(entry) ? entry.slice(0, -1) : entry).split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return 'has an empty, "." or ".." segment';
    const normal = path.posix.normalize(entry);
    if (normal !== entry) return 'is not in normal form';
    if (!normal.startsWith(PUBLISHED_FOLDER)) return `is outside ${PUBLISHED_FOLDER}`;
    return null;
}

function neverPublishReason(entry) {
    const repoPath = path.posix.normalize(entry);
    for (const [key, why] of Object.entries(NEVER_PUBLISH)) {
        if (key.endsWith('/') ? repoPath.startsWith(key) : repoPath === key) return why;
    }
    return null;
}

/** Every page the manifest publishes, landing page first, folders expanded. */
function publishedDocs(manifest, listFolder) {
    const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
    const named = new Set(sections.flatMap((s) => (s.docs || []).filter((d) => !isFolderEntry(d))));
    const docs = [LANDING_PAGE];
    for (const s of sections) {
        for (const entry of s.docs || []) {
            if (!isFolderEntry(entry)) {
                docs.push(entry);
                continue;
            }
            if (entryShapeRefusal(entry)) continue; // refused below
            for (const f of listFolder(entry).filter((f) => /\.md$/i.test(f) && !named.has(f)).sort()) docs.push(f);
        }
    }
    return docs;
}

/** Every forbidden coordinate in `text`, with its 1-based line. */
function forbiddenContentIn(text) {
    const hits = [];
    text.split('\n').forEach((line, i) => {
        for (const rule of FORBIDDEN_CONTENT) if (rule.re.test(line)) hits.push({ id: rule.id, why: rule.why, line: i + 1 });
    });
    return hits;
}

/** Why the manifest cannot be published; empty when it can. */
function publicationRefusals(manifest, readDoc, listFolder) {
    const refusals = [];
    const sections = Array.isArray(manifest.sections) ? manifest.sections : null;
    if (!sections) return ['the manifest has no "sections" array'];
    for (const s of sections) {
        if (typeof s.label !== 'string' || !s.label.trim()) refusals.push('a section has no label');
        for (const entry of s.docs || []) {
            const shape = entryShapeRefusal(entry);
            if (shape) {
                refusals.push(`${entry}: ${shape} (the help site publishes only plain paths under ${PUBLISHED_FOLDER})`);
            } else if (isFolderEntry(entry) && !listFolder(entry).some((f) => /\.md$/i.test(f))) {
                refusals.push(`${entry}: lists no docs`);
            }
        }
    }
    const seen = new Set();
    for (const doc of publishedDocs(manifest, listFolder)) {
        if (seen.has(doc)) refusals.push(`${doc}: listed twice`);
        seen.add(doc);
        if (entryShapeRefusal(doc)) continue; // already refused above; never read
        const never = neverPublishReason(doc);
        if (never) refusals.push(`${doc}: never published (${never})`);
        const text = readDoc(doc);
        if (text === null) {
            refusals.push(`${doc}: does not exist, or is not a regular file (a symbolic link is refused)`);
            continue;
        }
        for (const hit of forbiddenContentIn(text)) refusals.push(`${doc}:${hit.line}: carries ${hit.why} (${hit.id})`);
        if (!/^# .+$/m.test(text)) refusals.push(`${doc}: has no "# " title`);
    }
    return refusals;
}

/**
 * A doc as a Starlight page: its first `# ` heading becomes the frontmatter
 * title, and each relative Markdown link is rewritten (see the header).
 */
function stagePage(markdown, fromPath, published) {
    const titleMatch = /^# (.+)$/m.exec(markdown);
    const title = titleMatch ? titleMatch[1].trim() : slugFor(fromPath);
    const body = titleMatch ? markdown.replace(titleMatch[0], '').replace(/^\s*\n/, '') : markdown;
    const rewritten = body.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, bang, label, href) => {
        if (bang || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return whole;
        const [target, anchor] = href.split('#');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target));
        if (published.has(resolved)) {
            const slug = slugFor(resolved);
            return `[${label}](${SITE_BASE}/${slug === 'index' ? '' : slug + '/'}${anchor ? '#' + anchor : ''})`;
        }
        if (resolved.startsWith('docs/')) return label;
        return `[${label}](${GITHUB}/blob/main/${resolved}${anchor ? '#' + anchor : ''})`;
    });
    return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${rewritten}`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/**
 * A published doc's text, or null. Only a REGULAR file under `docs/user/` is
 * read: a symbolic link is refused, because its target can be any file on the
 * runner, and so is any path that resolves outside the folder.
 *
 * The file is opened ONCE, with O_NOFOLLOW, and everything after that is done
 * on the descriptor: the regular-file check is an fstat of what was opened and
 * the read is from the same descriptor. A check by path followed by a read by
 * path (lstat, then readFile) could be answered by one file and the read by
 * another, if the file were swapped for a link between the two calls. With
 * O_NOFOLLOW a link in the final component fails the open (ELOOP), and a swap
 * after the open cannot change what the descriptor names.
 */
function readRepoFile(repoPath) {
    if (entryShapeRefusal(repoPath)) return null;
    const abs = path.resolve(REPO_ROOT, repoPath);
    if (!isInside(path.join(REPO_ROOT, PUBLISHED_FOLDER), abs)) return null;
    // A platform without O_NOFOLLOW would OR in `undefined` (0) and follow
    // links silently, so it stops the build instead.
    if (typeof fs.constants.O_NOFOLLOW !== 'number') {
        throw new Error('docs site: this platform has no O_NOFOLLOW; refusing to read docs');
    }
    let fd;
    try {
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
        return null;
    }
    try {
        if (!fs.fstatSync(fd).isFile()) return null;
        return fs.readFileSync(fd, 'utf8');
    } finally {
        fs.closeSync(fd);
    }
}

/** True when `child` is `parent` or below it. */
function isInside(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Where a published doc is written; throws rather than write outside the content folder. */
function outputPathFor(doc, contentDir = CONTENT_DIR) {
    const out = path.resolve(contentDir, `${slugFor(doc)}.md`);
    if (!isInside(contentDir, out) || out === path.resolve(contentDir)) {
        throw new Error(`docs site: ${doc} would be written outside ${contentDir}`);
    }
    return out;
}

function listRepoFolder(folder) {
    const abs = path.join(REPO_ROOT, folder);
    if (!fs.existsSync(abs)) return [];
    return fs
        .readdirSync(abs, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.posix.join(folder, path.relative(abs, path.join(d.parentPath, d.name)).split(path.sep).join('/')));
}

function readManifest() {
    return JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'manifest.json'), 'utf8'));
}

/** Starlight sidebar entries for the manifest's sections (the landing page is "Overview"). */
function sidebarFrom(manifest, listFolder = listRepoFolder) {
    const landing = [{ label: 'What Inkquisitor is', link: '/' }];
    const sections = (manifest.sections || []).map((s) => ({
        label: s.label,
        items: publishedDocs({ sections: [s] }, listFolder)
            .filter((d) => d !== LANDING_PAGE)
            .map((d) => ({ slug: slugFor(d) })),
    }));
    return [...landing, ...sections.filter((s) => s.items.length > 0)];
}

function main() {
    const manifest = readManifest();
    const refusals = publicationRefusals(manifest, readRepoFile, listRepoFolder);
    if (refusals.length > 0) {
        process.stderr.write(`docs site: refusing to build:\n${refusals.map((r) => `  - ${r}`).join('\n')}\n`);
        process.exit(1);
    }
    const docs = publishedDocs(manifest, listRepoFolder);
    const published = new Set(docs);
    fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
    for (const doc of docs) {
        const out = outputPathFor(doc);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, stagePage(readRepoFile(doc), doc, published));
    }
    process.stdout.write(`docs site: staged ${docs.length} page(s)\n`);
}

module.exports = {
    SITE_BASE,
    SITE_TITLE,
    PUBLISHED_FOLDER,
    LANDING_PAGE,
    NEVER_PUBLISH,
    FORBIDDEN_CONTENT,
    slugFor,
    entryShapeRefusal,
    neverPublishReason,
    outputPathFor,
    publishedDocs,
    forbiddenContentIn,
    publicationRefusals,
    stagePage,
    sidebarFrom,
    readManifest,
    listRepoFolder,
    readRepoFile,
};

if (require.main === module) main();
