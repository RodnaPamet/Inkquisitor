# site/ — the Inkquisitor help site

An [Astro Starlight](https://starlight.astro.build/) site for people who USE
Inkquisitor, published to GitHub Pages at
https://rodnapamet.github.io/Inkquisitor/ by `.github/workflows/docs-site.yml`.

## What it publishes

`docs/user/` and nothing else. `manifest.json` is an ALLOWLIST:
`docs/user/index.md` ("What Inkquisitor is") is always the landing page, and
any other page is published only when a section of the manifest lists it.
`scripts/stage-docs.js` copies the allowlisted pages into
`src/content/docs/` (generated, gitignored) and refuses to build when:

- an entry is not a plain path under `docs/user/` (a `..` or `.` segment, a
  backslash, an absolute path, a path not in normal form);
- an entry names the roadmap, the carve manifest, the implementation notes,
  `CLAUDE.md` or the readme (`NEVER_PUBLISH`), checked on the normalised path;
- a published page is a symbolic link or not a regular file;
- a published page carries an operator coordinate (`FORBIDDEN_CONTENT`).

Keeping a doc off the site keeps it out of the site's navigation and search;
it is not confidentiality. A secret never belongs in `docs/`.

## Building

```bash
npm run docs:build                 # from the repository root
cd site && npm ci && npm run dev   # a local preview
```

The policy is unit-tested from the root suite (`tests/unit/docs-site.test.ts`).
The design and decisions are in the Phase 0.4 implementation note,
`docs/implementation-notes/2026-11-18-0.4-platform-services.md`.
