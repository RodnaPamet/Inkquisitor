# Inkquisitor

Inkquisitor takes an author from a book concept to publishing readiness by
**reverse prompting**: the product asks, the author answers. Every book element
(plot, characters, setting, theme, mood, texture, prose style, and so on) has a
**bible entry**. Clicking **Enrich** on an entry starts an interview about it,
and the answers are folded back into the bible as changes the author accepts or
rejects. The author sets how deep, how detailed and in what manner the
questions come.

The plan, the owner's decisions and the rules every change follows are in
[docs/ROADMAP.md](docs/ROADMAP.md). The repository is in Phase 0: an
application skeleton with its platform services (logging, tracing, error
reporting, rate limiting, storage, mail, a background-job worker) and CI.

## Running it locally

You need Node 24 (`.nvmrc`) and Docker.

```bash
npm ci                                   # installs and runs `prisma generate`
cp .env.example .env
docker compose up -d                     # Postgres + pgvector, PgBouncer, Redis, ClamAV
npm run dev                              # http://localhost:3000
npm run worker                           # the background-job worker (another terminal)
```

`GET /api/health` and `GET /api/livez` answer while the process is up;
`GET /api/readyz` answers 200 when PostgreSQL and Redis are reachable and 503
naming the one that is not.

Checks (CI runs the same):

```bash
npm run lint
npm run typecheck
npm test                                 # unit tests, no database
npm run test:integration                 # needs PostgreSQL, see below
npm run build
npm run test:e2e                         # after a build; Playwright on :3100
```

The integration tests read `DATABASE_URL`. Without it they use
`postgresql://postgres:postgres@localhost:5432/inkquisitor_test`; create that
database on a local PostgreSQL 16, or point `DATABASE_URL` at the compose
stack's Postgres (`localhost:5436`). They also need Redis: `REDIS_URL`, or
`redis://localhost:6379` (they use logical database 14).

The E2E suite needs the Chromium build its `@playwright/test` version expects
(`npx playwright install chromium`). Where only a different build is installed
and cannot be downloaded, point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at a
Chromium (or headless-shell) binary and Playwright launches that instead.

## Licence

Business Source License 1.1, licensor Inflect Ltd. — see [LICENSE](LICENSE)
and the plain-language summary in [LICENSING.md](LICENSING.md). Inkquisitor is
derived in part from inflect-compliance by the same licensor; see
[NOTICE](NOTICE) and [docs/carve-manifest.md](docs/carve-manifest.md).
