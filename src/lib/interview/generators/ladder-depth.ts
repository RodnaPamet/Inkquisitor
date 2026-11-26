/**
 * How far down the deepening ladder a session goes (Phase 4.4, D23: the depth dial sets how far down a session goes
 * instead of capping rounds). Depth 1 reaches two layers (what, why), depth 5 all six. Client-safe, on its own so the
 * setup sheet's preview reads it without the generators.
 */
import { LADDER_LAYERS } from '../vocabulary';

export function ladderDepthFor(depth: number): number {
    return Math.max(1, Math.min(LADDER_LAYERS.length, depth + 1));
}
