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

// The prose checks (Phase 5.2): a scene save queues its check on BullMQ. No
// suite reaches the queue unless it hands the usecase a queue of its own
// (`enqueueProseCheck`), so a save in an unrelated suite opens no Redis
// connection the open-handle environment would then fail it for.
process.env.PROSE_CHECKS = process.env.PROSE_CHECKS || 'off';

// Quiet logs: the structured logger writes JSON to stdout, which buries test
// output. A suite that asserts on log lines builds its own logger against a
// capturing destination (tests/unit/observability/logger-redaction.test.ts).
process.env.LOG_LEVEL = process.env.LOG_LEVEL_IN_TEST || 'silent';
