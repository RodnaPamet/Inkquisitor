/**
 * The prose checks' keyed hashes (Phase 5.2, D34). Server-only. Each is
 * HMAC-SHA256 under the workspace's own subkey for its purpose
 * (`workspaceSubkey`), never a plain digest of author text: equal text keys
 * equal within one workspace and unrelated across workspaces, and a key
 * reveals nothing a dictionary could find.
 *
 *   textKey      the stored scene HTML a check read: the check stands while
 *                the scene's text still keys the same (a details-only save
 *                moves the revision, not the text)
 *   configKey    the compiled style sheet, the inclusive-language switch and
 *                the rules version a check ran under: a change reads OUTDATED
 *   sentenceKey  a finding's normalised sentence and its rule: the dismissal
 *                key (D34 item 3) — a changed sentence keys differently, and so
 *                re-raises its note
 */
import { createHmac } from 'node:crypto';
import { workspaceSubkey } from '@/lib/security/encryption';
import { canonicalSheet, type CompiledStyleSheet } from './style-sheet';
import { PROSE_RULES_VERSION, type ProseRuleId } from './vocabulary';

function keyed(purpose: string, workspaceId: string, text: string): string {
    return createHmac('sha256', workspaceSubkey(purpose, workspaceId)).update(text.normalize('NFC'), 'utf8').digest('hex');
}

export function proseTextKey(workspaceId: string, storedHtml: string): string {
    return keyed('inkquisitor-prose-text/1', workspaceId, storedHtml);
}

export function proseConfigKey(workspaceId: string, sheet: CompiledStyleSheet, alexEnabled: boolean, rulesVersion = PROSE_RULES_VERSION): string {
    return keyed('inkquisitor-prose-config/1', workspaceId, JSON.stringify([rulesVersion, alexEnabled, canonicalSheet(sheet)]));
}

export function proseSentenceKey(workspaceId: string, ruleId: ProseRuleId, normalisedSentence: string): string {
    return keyed('inkquisitor-prose-dismissal/1', workspaceId, `${ruleId}\u0000${normalisedSentence}`);
}
