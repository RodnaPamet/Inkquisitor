/**
 * HOW LONG A MODEL CALL'S RECORD IS KEPT (Phase 2.H, issue #30 item 4).
 *
 * `AiCallLog` holds no text (numbers and names only, rule 4) and is
 * append-only by trigger. It is kept `AI_CALL_LOG_RETENTION_DAYS` days
 * (default `DEFAULT_RETENTION_DAYS`, 400: thirteen months and a margin, so a
 * year-on-year comparison of a whole month always has both months), then the
 * daily `ai-call-log-retention` job deletes it, through the ONE delete the
 * append-only trigger admits besides the cascades: by a role other than
 * app_user (the job's own connection, as `superuser_bypass` trusts it) of a
 * row older than `RETENTION_FLOOR_DAYS`, a floor written into the trigger
 * itself (migration `…_phase2_security_hardening`), so no configuration, and
 * no request, can delete a younger record.
 *
 * The figure is a CONSERVATIVE DEFAULT, not a decided policy: the retention
 * of call records is an owner decision (the 2.1 note's "a later decision"),
 * listed in the 2.H note. The ceiling is never affected: the month's spend
 * lives in `AiSpendMonth`.
 */

/** The database's own floor: the trigger refuses to delete a record younger than this. Keep equal to the migration's. */
export const RETENTION_FLOOR_DAYS = 365;
/** The default retention when `AI_CALL_LOG_RETENTION_DAYS` is unset. */
export const DEFAULT_RETENTION_DAYS = 400;
/** The longest retention the variable may name (about 27 years: a typo of digits is refused, not obeyed). */
export const MAX_RETENTION_DAYS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The retention in days, or null when the value is malformed or below the floor. Unset is the default. */
export function parseRetentionDays(raw: string | undefined): number | null {
    if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
    const text = raw.trim();
    if (!/^\d{1,5}$/.test(text)) return null;
    const days = Number(text);
    return days >= RETENTION_FLOOR_DAYS && days <= MAX_RETENTION_DAYS ? days : null;
}

/** The days a process keeps records for: a malformed value never shortens it (it reads as the default). */
export function retentionDays(raw: string | undefined): number {
    return parseRetentionDays(raw) ?? DEFAULT_RETENTION_DAYS;
}

/** Records started before this instant are due. */
export function retentionCutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - Math.max(days, RETENTION_FLOOR_DAYS) * DAY_MS);
}

/** What production refuses to start with. */
export function retentionConfigProblems(raw: string | undefined): string[] {
    return parseRetentionDays(raw) === null
        ? [`AI_CALL_LOG_RETENTION_DAYS must be a whole number of days from ${RETENTION_FLOOR_DAYS} to ${MAX_RETENTION_DAYS} (default ${DEFAULT_RETENTION_DAYS}).`]
        : [];
}
