-- Phase 4.4 — continuous, deep questioning (decisions D23 and D30): the enum
-- values first, in a migration of their own, because PostgreSQL does not let a
-- transaction use an enum value it added (the next migration's CHECKs name them).
--
-- One deploy (as D22's PLOT_BEAT): no row holds a new value until code that
-- knows it writes one.

-- CreateEnum
CREATE TYPE "QuestionGenerator" AS ENUM ('FRONTIER', 'LADDER', 'RELATIONS', 'SOURCES', 'CONTINUITY');

-- CreateEnum
CREATE TYPE "InterviewLengthMode" AS ENUM ('ROUNDS', 'QUESTIONS', 'UNTIL_STOPPED');

-- AlterEnum
ALTER TYPE "InterviewStopReason" ADD VALUE 'QUESTION_BUDGET';
ALTER TYPE "InterviewStopReason" ADD VALUE 'VALUE_FELL';
ALTER TYPE "InterviewStopReason" ADD VALUE 'SESSION_LIMIT';
-- Owner decision 2026-11-26 (A): every question left is about a field whose proposed change is still pending.
ALTER TYPE "InterviewStopReason" ADD VALUE 'AWAITING_DECISIONS';

-- AlterEnum
ALTER TYPE "QuestionOrigin" ADD VALUE 'GENERATOR';
