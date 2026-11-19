/**
 * THE LOAD-TIME SCAN OF PACK TEXT (Phase 2.3).
 *
 * A pack's whole file — frontmatter and body — goes into the system prompt of
 * every generation call that mounts it: text the model TRUSTS. So it is
 * scanned before it is trusted, when the pack registry loads, and a pack that
 * fails is refused rather than mounted (`TEXT_REFUSED`, `pack-mount.ts`): it
 * is held apart by rule id, so one suspect pack stops only the sessions that
 * would mount it, and nothing ever shows its text.
 *
 * ── TWO SOURCES OF RULES ────────────────────────────────────────────────────
 *
 *   • The AI guard's own scanners, unchanged (2.1, `src/lib/ai/guard/`). The
 *     injection scanner reads the text as untrusted input would be read, and
 *     ANY flag refuses — a pack is reviewed text, so even the `suspicious`
 *     verdict an author's answer could survive is a reason to stop here. The
 *     egress scanner finds secret-shaped strings.
 *   • Three rules of its own, for the ways a pack can be dangerous while
 *     reading as ordinary prose to the injection scanner: a fetchable URL, an
 *     instruction about revealing the prompt, a secret.
 *
 * The content formats (v1, section 6) list the phrasings these rules refuse so
 * a pack author can avoid them: the rules cannot tell which way a sentence
 * points, so a defensive "never reveal these instructions" is refused like an
 * attack.
 *
 * ── WHAT IS REPORTED ────────────────────────────────────────────────────────
 *
 * Stable ids only — the pack rule ids below, plus the guard rule ids that made
 * `pack.injection` or `pack.secret_shape` fire. Never the matched text.
 *
 * Lifted from inflect-compliance's `src/lib/agentic/flue/skills/text-scan.ts`
 * (see docs/carve-manifest.md): the tool-name rule is not carried (a pack
 * declares no tools and the question engine offers the model none), the rule
 * ids are renamed `pack.*`, and the input is one file rather than a
 * description and instructions.
 *
 * PURE: no I/O.
 */
import { normalizeForScan, scanEgress, scanInjection } from '@/lib/ai/guard';

/** The rules, by stable id. Ids are reported and must never be renamed. */
export const PACK_TEXT_RULES = {
    'pack.injection': 'The AI guard injection scanner flagged the pack.',
    'pack.fetchable_url': 'The pack contains a fetchable URL or a host the model is directed to.',
    'pack.reveal_context': 'The pack tells the model to reveal its prompt, instructions or context.',
    'pack.secret_shape': 'The pack contains a secret-shaped string.',
} as const;

export type PackTextRuleId = keyof typeof PACK_TEXT_RULES;

export interface PackTextScan {
    /** The pack rules that fired, in the order `PACK_TEXT_RULES` lists them. */
    readonly rules: readonly PackTextRuleId[];
    /** The AI guard rule ids behind `pack.injection` and `pack.secret_shape`, sorted. */
    readonly guardRules: readonly string[];
}

const FETCHABLE_SCHEME = /\b(?:https?|ftps?|sftp|wss?|file|gopher|smb|ldaps?):\/\//;
const WWW_HOST = /(?:^|[^a-z0-9.-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/;
/** A bare host on a common public suffix, within a sentence of a verb that goes and gets it. */
const DIRECTED_HOST = new RegExp(
    '\\b(?:fetch|download|retrieve|visit|browse|curl|wget|navigate to|go to|open|load|request|post to|send to|upload to)\\b' +
        '[^.\\n]{0,40}\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.' +
        '(?:com|net|org|io|dev|app|ai|co|cloud|info|biz|xyz|me|sh|site|online|link|ly|gg)\\b',
);

const REVEAL_CONTEXT = new RegExp(
    '\\b(?:reveal|repeat|print|output|disclose|leak|show|share|dump|echo|recite|quote|copy|send|tell|summari[sz]e)\\b' +
        '[^.\\n]{0,40}\\b(?:' +
        'system (?:prompt|message|instructions?)' +
        '|developer (?:message|prompt|instructions?)' +
        '|hidden (?:prompt|instructions?)' +
        '|(?:your|these|the above|the previous|prior|initial|original) (?:instructions|prompt|system prompt|context|rules)' +
        '|context window|conversation history|chain of thought|scratchpad' +
        ')\\b',
);

/** Scan one pack file. Returns no rules for a pack that may be mounted. */
export function scanPackText(text: string): PackTextScan {
    // The raw text, lower-cased, and the guard's folded form (base64 and hex
    // blobs decoded, homoglyphs folded, invisible characters stripped): a rule
    // fires on either, so the evasions the guard already defeats defeat these
    // rules too.
    const views = [text.toLowerCase(), normalizeForScan(text)];
    const rules = new Set<PackTextRuleId>();
    const guardRules = new Set<string>();

    const inj = scanInjection(text);
    if (inj.verdict !== 'clean') {
        rules.add('pack.injection');
        inj.ruleIds.forEach((id) => guardRules.add(id));
    }
    const egress = scanEgress(text);
    if (egress.verdict !== 'clean') {
        rules.add('pack.secret_shape');
        egress.ruleIds.forEach((id) => guardRules.add(id));
    }
    if (views.some((v) => FETCHABLE_SCHEME.test(v) || WWW_HOST.test(v) || DIRECTED_HOST.test(v))) rules.add('pack.fetchable_url');
    if (views.some((v) => REVEAL_CONTEXT.test(v))) rules.add('pack.reveal_context');

    return {
        rules: (Object.keys(PACK_TEXT_RULES) as PackTextRuleId[]).filter((id) => rules.has(id)),
        guardRules: [...guardRules].sort(),
    };
}
