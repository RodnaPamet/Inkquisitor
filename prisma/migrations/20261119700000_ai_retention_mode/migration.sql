-- Phase 2.2 — decision D5, amended 2026-11-19: a production process declares
-- its retention mode (AI_RETENTION_MODE=zdr | standard-beta). A call refused
-- because none is declared is recorded RETENTION_MODE_UNDECLARED, a new
-- AiCallLog error code; 2.1's ZDR_NOT_CONFIRMED stays in the vocabulary for
-- rows written before it. AI_ERROR_CODES in src/lib/ai/errors.ts is the same
-- set (tests/unit/ai/error-codes.test.ts reads the latest definition).
--
-- Widening a CHECK: drop and re-add in one transaction (migrate deploy runs
-- each migration in one). Every existing row satisfies the wider list.

ALTER TABLE "AiCallLog" DROP CONSTRAINT "AiCallLog_errorCode_known";

ALTER TABLE "AiCallLog"
    -- AI_ERROR_CODES in src/lib/ai/errors.ts; a new code widens this list in a migration.
    ADD CONSTRAINT "AiCallLog_errorCode_known" CHECK ("errorCode" IS NULL OR "errorCode" IN (
        'AI_DISABLED', 'CREDENTIAL_NOT_CONFIGURED', 'SDK_AMBIENT_HEADERS_SET', 'ZDR_NOT_CONFIRMED',
        'RETENTION_MODE_UNDECLARED',
        'PROVIDER_HTTP_ERROR', 'PROVIDER_CONNECTION', 'REQUEST_REFUSED', 'MODEL_REFUSED', 'INTERNAL_ERROR',
        'INVALID_AFTER_REPAIR', 'TRUNCATED', 'NO_OUTPUT',
        'GUARD_BLOCKED_INPUT', 'GUARD_BLOCKED_OUTPUT', 'GUARD_UNAVAILABLE',
        'SPEND_CEILING', 'DEADLINE', 'CALLER_ABORT'
    ));
