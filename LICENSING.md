# Licensing

Inkquisitor is **source-available**, licensed under the
**Business Source License 1.1 (BUSL-1.1)**. The full terms are in
[`LICENSE`](./LICENSE); this page is a plain-language summary — the `LICENSE`
file always governs.

## What you can do

- **Read, fork, modify, and self-host** the source freely.
- **Run it in production for your own writing**, or for your own
  organization's internal editorial work.
- **Contribute** back.

## What you can't do (without a commercial license)

- Offer the Licensed Work to third parties as a **hosted, managed, embedded,
  or SaaS** book-development, manuscript, story-planning, writing-assistant or
  author-interview product or service that **competes** with an Inflect
  offering.

If your intended use falls outside the grant above, contact **ivo@inflect.bg**
for a commercial license.

## It becomes open source over time

BUSL is not an open-source license, but it converts to one automatically.
Each released version relicenses to the **Apache License, Version 2.0** on its
**Change Date** — four years after that version was first made publicly
available. So the initial version is Apache-2.0 by 2030-11-18, and every
subsequent release opens on its own four-year clock.

GitHub will **not** display an open-source badge for this repository; that is
expected and correct (BUSL is source-available, not OSI-approved open source).

## Code derived from inflect-compliance

Inkquisitor is carved out of inflect-compliance: parts of its platform (the
application skeleton, and in later phases the UI platform, the canvas, the
model-call seam and the SaaS foundations) are copied from that repository and
adapted. Both works have the **same licensor**, Inflect Ltd., and both are
licensed under BUSL-1.1, so the licensor relicenses the copied code into
Inkquisitor under this repository's `LICENSE` — its Additional Use Grant and
its Change Date — not inflect-compliance's.

Every copied or adapted file is listed, with its source path and the source
commit, in [`docs/carve-manifest.md`](./docs/carve-manifest.md).

## Third-party components

Designs and code ported from permissively licensed third-party projects (MIT
or Apache-2.0, listed in `docs/ROADMAP.md` section 1.2) are credited in
[`NOTICE`](./NOTICE) when they land. No code or question text is taken from
copyleft, source-available or unlicensed projects (roadmap rule 7). npm
dependencies keep their own licenses.
