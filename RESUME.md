# Resume here — Inkquisitor build, paused 2026-11-18

Work paused because the owner's weekly model quota was nearly spent. This
branch (`wip/content`) and two others hold everything that was in progress, so
a fresh session can continue without the original container.

## Where things stand

| Item | State | Where |
|---|---|---|
| Roadmap | merged | `docs/ROADMAP.md` on `main` (decisions D1–D6 recorded in section 2) |
| 0.1 Repository bootstrap | merged, PR #1 | `main` |
| 0.2 UI platform | merged, PR #2 | `main` |
| 0.4 Platform services and tooling | **PR #3 open** | branch `claude/inkquisitor-roadmap-moryt6` |
| 0.3 Identity, workspaces, RLS | partial, never reviewed | branch `wip/0.3` |
| 2.1 core (model seam, guards) | barely started | branch `wip/2.1-core` |
| Phase 1–2 content | partial | this branch, `wip/staging/` |
| 0.H, Phase 1, rest of Phase 2 | not started | — |

### PR #3 (0.4)
CI was green on Lint, Typecheck, Test, Build and Security. **CodeQL failed**:
the repo's own gate (`scripts/sarif-gate.js`) blocked six alerts:

- `js/double-escaping` and `js/incomplete-multi-character-sanitization` in `src/components/ui/VersionDiff.tsx` (`htmlToLines`);
- `js/user-controlled-bypass` in `src/middleware.ts` (rate-limit tier chosen from the path);
- `js/file-system-race` in `site/scripts/stage-docs.js` (lstat then read);
- `js/redos` in `tests/guards/client-modules-import-no-server-env.test.ts`;
- `js/bad-tag-filter` in `tests/rendered/rich-text-editor.test.tsx`.

A fix workflow (`wip/tooling/codeql-fixes-workflow.js`) was running when work
paused. If its fixes were pushed to `claude/inkquisitor-roadmap-moryt6`, re-check
PR #3's CI. If not, re-run that workflow against a checkout of the PR branch. The
rule is to fix root causes: never lower the gate, never suppress. The Docker job
(image build plus Trivy) had not finished when work paused.

Merge PR #3 only when every check is green, using a **merge commit**, not a
squash. `wip/0.3` and `wip/2.1-core` descend from the PR #3 head (`d6bec52`) and
merge cleanly only if that history is kept.

### Owner actions outstanding
- Switch the repository's default branch to `main`. It is still the
  `claude/…` branch because that was the only branch when the repo was created.

## How the work was being done

Each subphase is one PR. A workflow in `wip/tooling/subphase-workflow.js` runs
five stages:

1. Implement: one agent.
2. Review: five default lenses plus subphase-specific ones.
3. Verify: skeptics try to refute each finding.
4. Fix: an agent applies the confirmed findings.
5. Complete: a critic checks the brief item by item, then a loop re-runs every check.

Its arguments are `id`, `title`, `brief`, `lenses`, plus `repo` (a git worktree
path), `dbSuffix`, `port` and `parallelNote` so several subphases can build at
once. The exact arguments used for 0.1, 0.2, 0.3, 0.4 and 2.1-core are in
`wip/tooling/subphase-args.json`. Reuse them.

Landing a subphase: commit in the worktree, merge `origin/main` into it, resolve
conflicts by keeping both sides, run every check, push to
`claude/inkquisitor-roadmap-moryt6`, open the PR, merge when green.

## Next steps, in order

1. **Finish PR #3** (above) and merge it.
2. **0.3.** Check out `wip/0.3` in a worktree. It was mid-implementation, with
   these steps done:
   - deps;
   - the Prisma schema (`enums`, `auth`, `workspace`) and a migration with RLS.

   The DB layer was in progress. These were not started: auth config, sign-up,
   sessions, middleware, the `/w/[workspaceSlug]` routes and pages, tests and
   docs. Resume with the subphase workflow and the `0.3` args. The implementer
   should treat the existing files as a starting point and verify them, since
   nothing there has been reviewed. Merge `main` first if PR #3 has landed
   since.
3. **0.H.** Phase 0 hardening. Roadmap prompt plus the notes in
   `wip/tooling/early-briefs-0.2-0.H.md`. Two items carried here from review:
   - rate-limit keys use the client-supplied leftmost `X-Forwarded-For` (decide once the deployment proxy is known);
   - the edge tiers log `requestId: unknown`.
4. **Phase 1** (1.1–1.H). The bible templates in `wip/staging/templates/` are
   the field templates for 1.1. Move them into the repo, e.g.
   `src/lib/bible/templates/`, and validate them with Zod.
5. **Phase 2.** `wip/2.1-core` started the workspace-independent model layer
   (args `2.1-core`); it lands after 1.H. 2.2–2.5 use the staged packs and evals.

## The staged content (`wip/staging/`)

Written by `wip/tooling/content-workflow.js`. Each pack was reviewed for
originality and licence hygiene (no branded framework names, no GPL text) and
for decision D3 (the AI never writes story content).

**Done:**
- `FORMAT.md`: the file formats.
- `templates/*.json`: 15 element kinds.
- `packs/craft/<kind>/`: 14 craft packs, each `PACK.md` plus `evals.json`.
- `packs/personas/`: 6 personas.
- `evals/question-coverage.json`: 10 book concepts.

**Not done** (the workflow was stopped first):
- `evals/enrichment.json` (40 answer/field cases);
- `evals/adversarial.json` (10 injection cases);
- the three question-engine designs, their judging and `design/QUESTION-ENGINE.md`;
- the final consistency pass and `README.md`.

Check `packs/personas/` for completeness too; all six were started.

Re-running `content-workflow.js` redoes everything. Faster: run only its
`evalsTask`, `designTask` and `Consistency` sections against this folder.

## Environment notes for a fresh container

- **Node 24** (CI and the engines field). The container had Node 22 first on
  `PATH`. Node 24 was installed checksum-verified to `/opt/node24`, and every
  command was run with `export PATH=/opt/node24/bin:$PATH`.
- **Postgres and Redis:** `service postgresql start`, `service redis-server
  start`, and the `postgres` password set to `postgres`. Each worktree used its
  own databases, `inkquisitor_test_<suffix>`.
- **No pgvector locally.** It is not needed before Phase 4.
- **Playwright:** the bundled browser cannot be downloaded. Use
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`.
- **npm 11 may skip install scripts.** Run `npm run db:generate` after `npm ci`.
- **GitHub push protection** rejects secret-shaped literals, even fake ones in
  tests. Build such fixtures at run time (see `tests/unit/detect-secrets.test.ts`
  on PR #3).
- **No ANTHROPIC_API_KEY** was available. Phase 2's evaluation records need
  real model runs; ask the owner for a key (the `request_credential` tool, host
  `api.anthropic.com`) when Phase 2 reaches them.
