export const meta = {
  name: 'inkquisitor-codeql-fixes',
  description: 'Fix the six CodeQL alerts blocking PR #3 at their root cause, each with a regression test, then verify each fix adversarially',
  phases: [
    { title: 'Fix', detail: 'one agent per alert group, disjoint files' },
    { title: 'Verify', detail: 'skeptic per fix: does it close the weakness the query describes, not just silence it' },
    { title: 'Repair', detail: 'redo any fix a skeptic rejected' },
    { title: 'Checks', detail: 'full local check suite' },
  ],
}
const REPO = '/home/user/ink-0.4'
const COMMON = `Repository: ${REPO} (Inkquisitor, a git worktree on local branch wip-0.4; the PR for it is in CI). Start shell commands with: export PATH=/opt/node24/bin:$PATH && cd ${REPO} && ... Do NOT git commit, push, stash or branch: leave edits in the working tree. Other agents are fixing OTHER files in this same checkout at the same time: touch only the files your task names (plus a test file of your own), and do not run npm install, npm run build or the integration tests. You may run npm run lint, npm run typecheck and single Jest files (npx jest <path>).

Context: CI's CodeQL job (github/codeql-action, javascript-typescript, default + security-extended queries) produced SARIF that scripts/sarif-gate.js blocks on. The owner's rule is to fix the root cause, never to lower the gate, suppress the alert, or add an allowlist entry. If you conclude an alert is a genuine false positive, restructure the code so the intent is explicit and the query no longer applies, and say exactly why in your answer.`
const ALERTS = [
  { key: 'versiondiff', files: 'src/components/ui/VersionDiff.tsx (function htmlToLines, line ~72) and its tests (tests/rendered/version-diff*.test.tsx or a new one)', alerts: 'js/double-escaping (severity 7.8): entities are decoded in an order that turns "&amp;lt;" into "<", i.e. text the author wrote literally as "&lt;" is decoded twice. js/incomplete-multi-character-sanitization (7.8): the single-pass tag strip `.replace(/<[^>]+>/g, \'\')` can leave a tag behind (for example "<<b>script>"), so the output can still contain markup.', guidance: 'htmlToLines converts stored HTML (from RichTextEditor) into plain text lines for a line diff that React renders as text. Make it correct, not just quiet: decode entities in a single pass (one regex with a lookup map, so "&amp;lt;" becomes the literal text "&lt;"), and remove tags so that no "<" that starts a tag can survive (loop the strip until the string stops changing, or tokenise). Keep the block-boundary behaviour (br, closing p/h1-6/li/blockquote/pre, hr become line breaks). Add tests for: "&amp;lt;b&amp;gt;" yields the literal "&lt;b&gt;"; "<<b>script>alert(1)<</b>/script>" leaves no "<script"; the existing paragraph/heading behaviour unchanged.' },
  { key: 'middleware', files: 'src/middleware.ts (line ~42) and the rate-limit tier modules it calls (src/lib/rate-limit/*), plus their tests', alerts: 'js/user-controlled-bypass (error, 7.8): a security check (rate limiting) is guarded by a condition on user-controlled data (the request pathname/method), so a crafted request may skip the check.', guidance: 'Find out whether a crafted path can really reach an auth or API route while escaping both tiers: percent-encoding (/api/%61uth/…), case (/API/auth), duplicate or trailing slashes (//api/auth, /api/auth/), dot segments, method spoofing (HEAD vs GET), x-middleware-* headers. Read how Next 16 normalises req.nextUrl.pathname and how routing matches. Then restructure so the tier is chosen by a single classifier over a NORMALISED path (decode once, collapse slashes, lowercase for comparison) that returns a tier for every request it should cover, and the limiter is always called with that tier (a "none" tier only for the explicitly excluded probes). Add tests that feed each crafted variant through the middleware and assert it is limited. If after this CodeQL would still see "condition on user data guards the check", make the call unconditional with the tier as an argument.' },
  { key: 'stage-docs', files: 'site/scripts/stage-docs.js (line ~205) and its test', alerts: 'js/file-system-race (7.7): the file is checked with fs.lstatSync and then read with fs.readFileSync by path, so it can be swapped (for a symlink outside the published folder) between the check and the read.', guidance: 'Open once and work on the descriptor: fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), fs.fstatSync(fd).isFile(), read from the fd, close in finally. Keep the isInside and entry-shape checks. Add a test that a symlink in the published folder is refused (O_NOFOLLOW makes open fail with ELOOP) and a regular file is read.' },
  { key: 'redos', files: 'tests/guards/client-modules-import-no-server-env.test.ts (line ~16)', alerts: 'js/redos (error, 7.5): the USE_CLIENT regex /^\\s*(?:\\/\\/[^\\n]*\\n|\\/\\*[\\s\\S]*?\\*\\/\\s*)*\\s*[\'"]use client[\'"]/ has ambiguous nested repetition that can backtrack exponentially on crafted input.', guidance: 'Replace the regex with a small linear scanner (skip whitespace, line comments and block comments in a loop, then check for the directive), or an unambiguous regex. Keep the guard\'s behaviour; add unit cases for the scanner (directive after comments; directive not first; a long run of unterminated "/*" completes fast).' },
  { key: 'tag-filter', files: 'tests/rendered/rich-text-editor.test.tsx (line ~154)', alerts: 'js/bad-tag-filter (7.8): the assertion `expect(seeded).not.toMatch(/<script>/)` is a regex tag filter that misses variants such as "<script >" or "<SCRIPT>".', guidance: 'Assert on structure instead: parse the editor output into a detached element (document.createElement("template").innerHTML = seeded) and assert it contains no script element and no element with an on* attribute; keep the positive assertion that the text was escaped.' },
]
const FIX = { type: 'object', properties: { summary: { type: 'string' }, rootCause: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, testsAdded: { type: 'array', items: { type: 'string' } }, checks: { type: 'string' } }, required: ['summary', 'rootCause', 'filesChanged', 'testsAdded'] }
const VERDICT = { type: 'object', properties: { accepted: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['accepted', 'problems'] }

const results = await pipeline(
  ALERTS,
  a => agent(`${COMMON}

Your task: fix CodeQL alert(s) in ${a.files}.

Alert(s): ${a.alerts}

Guidance: ${a.guidance}

Write the failing test first where the alert describes a behaviour, then fix, then run lint, typecheck and the affected Jest files.`, { label: `fix ${a.key}`, phase: 'Fix', schema: FIX, effort: 'high' }),
  (fix, a) => agent(`${COMMON}

You are a skeptic reviewing a fix for CodeQL alert(s) in ${a.files}. READ-ONLY: do not edit files.

Alert(s): ${a.alerts}

The fixer reports: ${JSON.stringify(fix)}

Read the current code (git diff HEAD -- <files>) and decide: does the change remove the weakness the query describes, for every input, rather than only changing the code shape so the query stops matching? Would CodeQL's query, as documented, still flag it? Did it break behaviour (run the affected tests)? Are the new tests able to fail if the fix is reverted? accepted=false with concrete problems if anything is wrong.`, { label: `verify ${a.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' })
    .then(v => ({ a, fix, v })),
  async r => {
    if (!r || !r.v || r.v.accepted) return r
    const redo = await agent(`${COMMON}

A skeptic rejected the fix for CodeQL alert(s) in ${r.a.files}.
Alert(s): ${r.a.alerts}
Guidance: ${r.a.guidance}
Skeptic's problems: ${JSON.stringify(r.v.problems)}
Address every problem, then run lint, typecheck and the affected Jest files.`, { label: `repair ${r.a.key}`, phase: 'Repair', schema: FIX, effort: 'high' })
    return { ...r, redo }
  },
)

phase('Checks')
const checks = await agent(`${COMMON.replace('Other agents are fixing OTHER files in this same checkout at the same time: touch only the files your task names (plus a test file of your own), and do not run npm install, npm run build or the integration tests.', 'You are the only agent running now.')}

Run the full local suite with the s04 databases: export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/inkquisitor_test_s04 DIRECT_DATABASE_URL=$DATABASE_URL; then npm run lint, npm run typecheck, npm test, npm run test:integration, npm run build, npm run build:worker, npm --prefix site run build. If anything fails because of the CodeQL fixes in the working tree (git diff HEAD), fix it. Report each command's result.`, { label: 'full checks', phase: 'Checks', schema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['command', 'pass'] } } }, required: ['results'] }, effort: 'high' })

return { results: results.filter(Boolean).map(r => ({ key: r.a.key, rootCause: r.fix && r.fix.rootCause, accepted: r.v && r.v.accepted, problems: r.v && r.v.problems, redo: r.redo && r.redo.summary })), checks }
