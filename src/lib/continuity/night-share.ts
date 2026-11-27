/**
 * THE NIGHT'S ONE SHARE (Phase 5.3, D35 item 2): the nightly draft reading and the deep continuity check TOGETHER spend
 * at most `CONTINUITY_NIGHTLY_SHARE` (10 %) of the workspace's monthly ceiling a night — one budget, measured from the
 * ledger over BOTH purposes (what their calls charged in the night's window plus their live reservations), checked by
 * each before every call with the call's worst case and again by the ledger under its spend lock as the call reserves.
 *
 * ITS HALVES (D35 addendum B, owner decision 2026-11-27): each purpose takes at most `NIGHT_SHARE_HALF` of the share
 * (5 % of the month) while the OTHER still has work that night; whichever finishes, or has nothing to do, leaves the
 * rest to the other. Measured from the ledger by each purpose alone, and enforced by the ledger under its spend lock
 * with the other's work read in the same transaction (`NightlyShare.half`; built by `nightShareFor`). "Work this night"
 * is read from rows, never from a clock: the continuity check has work while a run of the night is queued or running;
 * the draft reading, while a run of the night is queued or running, or — before the night's dispatch has queued any
 * run in the workspace — while a scene waits to be read. Both halves together can never pass the share (the total
 * binds every call), so the two can never both be over half.
 *
 * ORDER WITHIN THE NIGHT: the continuity check runs first (02:23 UTC), the draft reading after (03:07). The check is
 * bounded per book (two deep calls) and protects the canon; the draft reading is the bulk (a whole manuscript on its
 * first nights) and resumable scene by scene. Since the halves, the reading is guaranteed its half while it has scenes
 * to read, and the check its half while it is running. Each draft fact is compared, as it is read, with the bible facts
 * that stand that night; the continuity check reads draft facts only for a book whose author turned that on
 * (addendum A), and those calls are the check's (its purpose, its half).
 */
import { DRAFT_READ_PURPOSE } from '@/lib/draft-facts/prompt';
import { CONTINUITY_PURPOSE } from './prompt';

export const NIGHT_SHARE_PURPOSES: readonly string[] = Object.freeze([CONTINUITY_PURPOSE, DRAFT_READ_PURPOSE]);

/** The part of the night's share each purpose may take while the other still has work (D35 addendum B). */
export const NIGHT_SHARE_HALF = 0.5;
