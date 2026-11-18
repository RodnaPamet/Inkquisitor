export const meta = {
  name: 'inkquisitor-subphase',
  description: 'Implement one Inkquisitor roadmap subphase, review it through several lenses, verify findings adversarially, fix, and check completeness',
  phases: [
    { title: 'Implement', detail: 'one agent builds the subphase in the working tree' },
    { title: 'Review', detail: 'read-only reviewers, one per lens' },
    { title: 'Verify', detail: 'skeptics try to refute each finding' },
    { title: 'Fix', detail: 'apply confirmed findings' },
    { title: 'Complete', detail: 'critic checks the brief item by item and runs every check; loop until done' },
  ],
}

const SHA = '5528464fc54a8681956f3b9ce23ca9c075f0420e'
const REPO = args.repo || '/home/user/Inkquisitor'
const DBS = args.dbSuffix || ''
const PARALLEL_NOTE = args.parallelNote || ''
const COMMON = `## Context (applies to every agent)
- Target repo: ${REPO} (a git checkout of Inkquisitor). Work only there. Your shell may start in another directory: always cd ${REPO} or use absolute paths. Never touch any other Inkquisitor checkout or worktree under /home/user: other subphases are being built there at the same time.${PARALLEL_NOTE ? '\n- ' + PARALLEL_NOTE : ''}
- Source repo: /home/user/inflect-compliance at commit ${SHA}. READ-ONLY, never modify it. The same owner owns both repositories and the same licensor (Inflect Ltd.) licenses both under BUSL-1.1, so copy code from it freely. Its CLAUDE.md describes inflect-compliance only: ignore its working agreements (opening/merging PRs, the production VM) here; its engineering rules are good guidance.
- Do NOT git commit, push, create branches, stash, or open PRs. Leave all changes in the working tree; the orchestrator commits.
- Node: start every shell command that runs node/npm/npx with: export PATH=/opt/node24/bin:$PATH && ... (Node 24, matching CI). Do not edit shell profiles.
- Local services already running: PostgreSQL 16 on localhost:5432 (user postgres, password postgres; the pgvector extension is NOT installed), Redis on localhost:6379. ${DBS ? 'Other checkouts use the same server, so use ONLY databases whose names end in _' + DBS + ' (e.g. inkquisitor_dev_' + DBS + ', inkquisitor_test_' + DBS + '), and set DATABASE_URL and DIRECT_DATABASE_URL to them for every command, including npm run test:integration. Use port ' + (args.port || 3000) + ' for any server you start.' : 'Create the databases you need (e.g. inkquisitor_dev, inkquisitor_test).'}
- There is no ANTHROPIC_API_KEY. No code path or test may call a model provider or any network service during tests.
- Owner decisions (docs/ROADMAP.md section 2): D1 tldraw stays pinned to 3.x, whose licence allows commercial use with the watermark on, so no licence key is needed (canvas is Phase 3, not now). D2 Inkquisitor is BUSL-1.1 with licensor Inflect Ltd., mirroring inflect-compliance's LICENSE. D3 the AI never writes manuscript prose. D4 one workspace per author with OWNER/EDITOR/READER memberships and row-level security from day one. D5 author text reaches the model provider only under zero-retention terms. D6 copy code from inflect-compliance at the recorded commit; no shared package.
- The nine rules in docs/ROADMAP.md section 3 bind every change.
- Checks: every script among npm run lint, npm run typecheck, npm test, npm run test:integration, npm run build that exists in package.json must pass before the work is finished.
- Implementation notes go in docs/implementation-notes/2026-11-18-<subphase-id>-<slug>.md (design, files, decisions; no test counts). Every file copied or adapted from inflect-compliance is listed in docs/carve-manifest.md.`

const READ_ONLY = `You are READ-ONLY: do not edit, create or delete files, and do not run npm install, npm run build, database migrations, integration tests or anything that writes to the database or to .next (other agents run concurrently). You may read files, run git diff/status/log, grep, npm run lint, npm run typecheck and unit tests.`

const { id, title, brief, lenses } = args

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    notDone: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, reason: { type: 'string' } }, required: ['item', 'reason'] } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['command', 'pass'] } },
  },
  required: ['summary', 'deviations', 'notDone', 'checks'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'number' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    notFixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['command', 'pass'] } },
  },
  required: ['fixed', 'notFixed', 'checks'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'missing', 'not-possible-here'] }, evidence: { type: 'string' } }, required: ['item', 'status', 'evidence'] } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, pass: { type: 'boolean' }, tail: { type: 'string' } }, required: ['command', 'pass'] } },
  },
  required: ['items', 'checks'],
}

const DEFAULT_LENSES = [
  { name: 'conformance', focus: 'Is every item of the brief actually implemented? List each item that is missing, partial, or claimed but not real. Check against the code, not against notes or comments.' },
  { name: 'correctness', focus: 'Bugs: broken logic, wrong types papered over, runtime errors, broken imports, unreachable code paths, race conditions, wrong defaults.' },
  { name: 'security-privacy', focus: 'Authorization gaps, workspace isolation, secrets in code or logs, injection, unsafe HTML, data leaks to client bundles or logs, unsafe defaults.' },
  { name: 'tests', focus: 'Would the tests fail if the behaviour they name regressed? Vacuous or tautological tests, tests not picked up by the jest config, behaviour with no test at all.' },
  { name: 'carve-hygiene', focus: 'Leftovers from inflect-compliance (compliance/tenant/control/evidence/audit vocabulary, dead imports, unused files, references to modules that were not copied), carve-manifest accuracy, licence hygiene (no GPL/AGPL code or question text), naming consistent with Inkquisitor.' },
]
const allLenses = DEFAULT_LENSES.concat(lenses || [])

phase('Implement')
const impl = await agent(`You are implementing subphase ${id} — ${title} — of the Inkquisitor roadmap.

${COMMON}

## The subphase brief
${brief}

## How to work
1. Read ${REPO}/docs/ROADMAP.md (sections 2-4), CLAUDE.md and docs/carve-manifest.md if present, and the repo state (git log --oneline, git status).
2. Study the inflect-compliance sources the brief names before copying. Copy whole files where possible, then edit them for Inkquisitor.
3. Implement every item of the brief. Where an item cannot be done in this environment, or the brief is wrong, do the closest correct thing and record it as a deviation or notDone item with the reason.
4. Write tests that fail when the behaviour regresses.
5. Run every check and make it pass. Do not finish with a failing check.
6. Update docs/carve-manifest.md, CLAUDE.md where conventions changed, and add the implementation note.
Return the structured summary.`, { label: `implement ${id}`, phase: 'Implement', schema: IMPL_SCHEMA, effort: 'high' })

const reviewed = await pipeline(
  allLenses,
  lens => agent(`Review the uncommitted work for Inkquisitor subphase ${id} — ${title} — through one lens: ${lens.name}. ${lens.focus}

${COMMON}

${READ_ONLY}

## The subphase brief
${brief}

The work under review is everything that differs from HEAD in ${REPO}: run git status --porcelain and git diff HEAD, and read untracked files in full. Report only real, specific defects, each with file and line and evidence (code quoted or a command and its output). No style nits, no speculation. An empty list is a valid answer.`, { label: `review ${lens.name}`, phase: 'Review', schema: FINDINGS_SCHEMA, effort: 'high' }),
  (review, lens) => {
    const findings = (review && review.findings) || []
    return parallel(findings.map(f => () => {
      const votes = f.severity === 'critical' || f.severity === 'high' ? 3 : 1
      return parallel(Array.from({ length: votes }, (_, k) => () => agent(`A reviewer (lens: ${lens.name}) claims this defect in the uncommitted work for Inkquisitor subphase ${id}:

Title: ${f.title}
Severity: ${f.severity}
Location: ${f.file || '?'}:${f.line || '?'}
Evidence: ${f.evidence}
Proposed fix: ${f.fix}

${COMMON}

${READ_ONLY}

Try to REFUTE the claim by reading the code and running safe commands. Set refuted=true if the claim is wrong, is already handled elsewhere, is out of scope for this subphase's brief, or is not a real problem. If you cannot confirm it, default to refuted=true. Skeptic #${k + 1}.`, { label: `verify ${lens.name}: ${f.title.slice(0, 40)}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'medium' })))
        .then(vs => {
          const live = vs.filter(Boolean)
          const kept = live.filter(v => !v.refuted).length
          const need = votes === 3 ? 2 : 1
          return { ...f, lens: lens.name, confirmed: kept >= need, votes: live.map(v => v.reason) }
        })
    }))
  },
)
const all = reviewed.filter(Boolean).flat().filter(Boolean)
const confirmed = all.filter(f => f.confirmed)
log(`${all.length} findings raised, ${confirmed.length} confirmed`)

phase('Fix')
let fixes = []
if (confirmed.length) {
  const fx = await agent(`Fix these confirmed defects in the uncommitted work for Inkquisitor subphase ${id} — ${title}.

${COMMON}

## The subphase brief (for scope)
${brief}

## Confirmed findings
${confirmed.map((f, i) => `${i + 1}. [${f.severity}/${f.lens}] ${f.title} — ${f.file || ''}:${f.line || ''}\nEvidence: ${f.evidence}\nFix: ${f.fix}`).join('\n\n')}

Several findings may describe the same defect. Fix each real defect properly, add or tighten the test that would have caught it, then run every check and make it pass.`, { label: `fix ${id}`, phase: 'Fix', schema: FIX_SCHEMA, effort: 'high' })
  fixes.push(fx)
}

phase('Complete')
let critic = null
for (let round = 1; round <= 3; round++) {
  critic = await agent(`Completeness critic for Inkquisitor subphase ${id} — ${title}, round ${round}.

${COMMON}

## The subphase brief
${brief}

Do two things. (1) Split the brief into its individual items and judge each against the code in ${REPO} (done / partial / missing / not-possible-here), with evidence from the code, not from notes. Use not-possible-here only for things this sandbox genuinely cannot do (for example real users, a real model API call, a production deploy). (2) Run every check that exists (npm run lint, npm run typecheck, npm test, npm run test:integration, npm run build) and report pass/fail with the tail of any failure. You may run these commands, but do not edit files.`, { label: `critic ${id} r${round}`, phase: 'Complete', schema: CRITIC_SCHEMA, effort: 'high' })
  if (!critic) break
  const gaps = critic.items.filter(i => i.status === 'partial' || i.status === 'missing')
  const red = critic.checks.filter(c => !c.pass)
  log(`round ${round}: ${gaps.length} gaps, ${red.length} failing checks`)
  if (!gaps.length && !red.length) break
  if (round === 3) break
  const fx = await agent(`Close these gaps in Inkquisitor subphase ${id} — ${title}.

${COMMON}

## The subphase brief
${brief}

## Gaps found by the completeness critic
${gaps.map(g => `- [${g.status}] ${g.item}: ${g.evidence}`).join('\n') || '(none)'}

## Failing checks
${red.map(c => `- ${c.command}: ${c.tail || ''}`).join('\n') || '(none)'}

Implement what is missing, fix what fails, add tests where behaviour is new, then run every check and make it pass.`, { label: `close gaps ${id} r${round}`, phase: 'Complete', schema: FIX_SCHEMA, effort: 'high' })
  fixes.push(fx)
}

return {
  id,
  impl,
  findings: all.map(f => ({ title: f.title, severity: f.severity, lens: f.lens, confirmed: f.confirmed, file: f.file })),
  fixes,
  critic,
}
