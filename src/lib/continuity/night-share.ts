/**
 * THE NIGHT'S ONE SHARE (Phase 5.3, D35 item 2): the nightly draft reading and the deep continuity check TOGETHER spend
 * at most `CONTINUITY_NIGHTLY_SHARE` (10 %) of the workspace's monthly ceiling a night — one budget, measured from the
 * ledger over BOTH purposes (what their calls charged in the night's window plus their live reservations), checked by
 * each before every call with the call's worst case and again by the ledger under its spend lock as the call reserves.
 *
 * ORDER WITHIN THE NIGHT: the continuity check runs first (02:23 UTC), the draft reading after (03:07). The check is
 * bounded per book (two deep calls) and protects the canon; the draft reading is the bulk (a whole manuscript on its
 * first nights) and resumable scene by scene, so it takes what the share has left and a large import can never starve
 * the bible's own check. Nothing is lost by the order: each draft fact is compared, as it is read, with the bible
 * facts that stand that night (4.1 extracts them during the day), and the continuity check never reads draft facts.
 */
import { DRAFT_READ_PURPOSE } from '@/lib/draft-facts/prompt';
import { CONTINUITY_PURPOSE } from './prompt';

export const NIGHT_SHARE_PURPOSES: readonly string[] = Object.freeze([CONTINUITY_PURPOSE, DRAFT_READ_PURPOSE]);
