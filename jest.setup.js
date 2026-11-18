// Runs before every test file, in both Jest projects.
//
// SKIP_ENV_VALIDATION keeps src/env.ts and src/env-client.ts from refusing to
// load when a suite reaches the real modules (Jest maps both to
// tests/mocks/env.ts, so this is the second line, not the first).
process.env.SKIP_ENV_VALIDATION = '1';

// The integration project's database. The shell (and CI, which exports it)
// wins; otherwise the documented local test database: PostgreSQL on 5432 with
// the postgres/postgres superuser and an `inkquisitor_test` database (see
// README.md). Unit tests never connect, so the value is inert for them.
// Never the development database from `.env`: integration tests will create
// and drop rows, and later whole schemas.
process.env.DATABASE_URL =
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/inkquisitor_test?schema=public';

// No test may reach a model provider. Phase 2's model seam refuses without a
// key; clearing it here means a key in a developer's shell never makes a test
// call out.
delete process.env.ANTHROPIC_API_KEY;
