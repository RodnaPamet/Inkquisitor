/**
 * Spelling variants (Phase 5.2, D34): a bounded, ORIGINAL list of word pairs
 * whose spelling divides British from American usage, and which form each
 * variety the style sheet offers prefers. Written for this product from
 * general knowledge of the varieties (no word list copied from any project).
 *
 * Only UNAMBIGUOUS pairs are listed: a form that is a different word in the
 * other variety (meter / metre, check / cheque, tire / tyre as a verb,
 * program / programme, story / storey, license / licence) and the -ise / -ize
 * endings (both are British) are left out, because a note on them would be
 * wrong as often as right. Canadian usage is mixed, so each family says which
 * form Canada takes, or that both are current (then nothing is flagged for a
 * Canadian sheet). Australian usage follows British for every family here.
 */
import type { StyleSpelling } from './vocabulary';

type CanadianForm = 'uk' | 'us' | 'both';

interface Family {
    /** The British form and the American form of the base word. */
    uk: string;
    us: string;
    /** Endings both forms take (the base itself is ''). */
    endings: readonly string[];
    canada: CanadianForm;
}

const FAMILIES: readonly Family[] = [
    // -our / -or
    { uk: 'colour', us: 'color', endings: ['', 's', 'ed', 'ing', 'ful', 'less'], canada: 'uk' },
    { uk: 'honour', us: 'honor', endings: ['', 's', 'ed', 'ing', 'able'], canada: 'uk' },
    { uk: 'favour', us: 'favor', endings: ['', 's', 'ed', 'ing', 'able', 'ite', 'ites'], canada: 'uk' },
    { uk: 'flavour', us: 'flavor', endings: ['', 's', 'ed', 'ing'], canada: 'uk' },
    { uk: 'labour', us: 'labor', endings: ['', 's', 'ed', 'ing', 'er', 'ers'], canada: 'uk' },
    { uk: 'neighbour', us: 'neighbor', endings: ['', 's', 'hood', 'hoods', 'ing', 'ly'], canada: 'uk' },
    { uk: 'harbour', us: 'harbor', endings: ['', 's', 'ed', 'ing'], canada: 'uk' },
    { uk: 'rumour', us: 'rumor', endings: ['', 's', 'ed'], canada: 'uk' },
    { uk: 'humour', us: 'humor', endings: ['', 's', 'ed', 'less'], canada: 'uk' },
    { uk: 'behaviour', us: 'behavior', endings: ['', 's', 'al'], canada: 'uk' },
    { uk: 'odour', us: 'odor', endings: ['', 's', 'less'], canada: 'uk' },
    { uk: 'vapour', us: 'vapor', endings: ['', 's'], canada: 'uk' },
    { uk: 'vigour', us: 'vigor', endings: [''], canada: 'uk' },
    { uk: 'valour', us: 'valor', endings: [''], canada: 'uk' },
    { uk: 'splendour', us: 'splendor', endings: ['', 's'], canada: 'uk' },
    { uk: 'armour', us: 'armor', endings: ['', 'ed', 'y'], canada: 'uk' },
    { uk: 'saviour', us: 'savior', endings: ['', 's'], canada: 'uk' },
    { uk: 'endeavour', us: 'endeavor', endings: ['', 's', 'ed', 'ing'], canada: 'uk' },
    { uk: 'parlour', us: 'parlor', endings: ['', 's'], canada: 'uk' },
    { uk: 'clamour', us: 'clamor', endings: ['', 's', 'ed', 'ing'], canada: 'uk' },
    { uk: 'tumour', us: 'tumor', endings: ['', 's'], canada: 'uk' },
    { uk: 'candour', us: 'candor', endings: [''], canada: 'uk' },
    { uk: 'ardour', us: 'ardor', endings: [''], canada: 'uk' },
    { uk: 'rancour', us: 'rancor', endings: [''], canada: 'uk' },
    { uk: 'savour', us: 'savor', endings: ['', 's', 'ed', 'ing', 'y'], canada: 'uk' },
    { uk: 'fervour', us: 'fervor', endings: [''], canada: 'uk' },
    { uk: 'demeanour', us: 'demeanor', endings: [''], canada: 'uk' },
    // -re / -er
    { uk: 'centre', us: 'center', endings: ['', 's'], canada: 'uk' },
    { uk: 'centred', us: 'centered', endings: [''], canada: 'uk' },
    { uk: 'theatre', us: 'theater', endings: ['', 's'], canada: 'uk' },
    { uk: 'fibre', us: 'fiber', endings: ['', 's'], canada: 'uk' },
    { uk: 'calibre', us: 'caliber', endings: [''], canada: 'uk' },
    { uk: 'sombre', us: 'somber', endings: [''], canada: 'uk' },
    { uk: 'spectre', us: 'specter', endings: ['', 's'], canada: 'uk' },
    { uk: 'lustre', us: 'luster', endings: [''], canada: 'uk' },
    { uk: 'sabre', us: 'saber', endings: ['', 's'], canada: 'uk' },
    { uk: 'meagre', us: 'meager', endings: [''], canada: 'uk' },
    { uk: 'litre', us: 'liter', endings: ['', 's'], canada: 'uk' },
    { uk: 'sceptre', us: 'scepter', endings: ['', 's'], canada: 'uk' },
    { uk: 'manoeuvre', us: 'maneuver', endings: ['', 's'], canada: 'uk' },
    { uk: 'manoeuvred', us: 'maneuvered', endings: [''], canada: 'uk' },
    // a doubled l
    { uk: 'travelled', us: 'traveled', endings: [''], canada: 'uk' },
    { uk: 'travelling', us: 'traveling', endings: [''], canada: 'uk' },
    { uk: 'traveller', us: 'traveler', endings: ['', 's'], canada: 'uk' },
    { uk: 'cancelled', us: 'canceled', endings: [''], canada: 'uk' },
    { uk: 'cancelling', us: 'canceling', endings: [''], canada: 'uk' },
    { uk: 'labelled', us: 'labeled', endings: [''], canada: 'uk' },
    { uk: 'labelling', us: 'labeling', endings: [''], canada: 'uk' },
    { uk: 'levelled', us: 'leveled', endings: [''], canada: 'uk' },
    { uk: 'modelled', us: 'modeled', endings: [''], canada: 'uk' },
    { uk: 'modelling', us: 'modeling', endings: [''], canada: 'uk' },
    { uk: 'quarrelled', us: 'quarreled', endings: [''], canada: 'uk' },
    { uk: 'signalled', us: 'signaled', endings: [''], canada: 'uk' },
    { uk: 'marvelled', us: 'marveled', endings: [''], canada: 'uk' },
    { uk: 'marvellous', us: 'marvelous', endings: ['', 'ly'], canada: 'uk' },
    { uk: 'jewellery', us: 'jewelry', endings: [''], canada: 'uk' },
    { uk: 'woollen', us: 'woolen', endings: ['', 's'], canada: 'uk' },
    { uk: 'fuelled', us: 'fueled', endings: [''], canada: 'uk' },
    { uk: 'counsellor', us: 'counselor', endings: ['', 's'], canada: 'uk' },
    { uk: 'dialled', us: 'dialed', endings: [''], canada: 'uk' },
    { uk: 'tunnelled', us: 'tunneled', endings: [''], canada: 'uk' },
    { uk: 'shovelled', us: 'shoveled', endings: [''], canada: 'uk' },
    { uk: 'panelled', us: 'paneled', endings: [''], canada: 'uk' },
    // -ence / -ense (nouns)
    { uk: 'defence', us: 'defense', endings: ['', 's', 'less'], canada: 'uk' },
    { uk: 'offence', us: 'offense', endings: ['', 's'], canada: 'uk' },
    { uk: 'pretence', us: 'pretense', endings: ['', 's'], canada: 'uk' },
    // -yse / -yze (British has only -yse)
    { uk: 'analyse', us: 'analyze', endings: ['', 's', 'd'], canada: 'us' },
    { uk: 'analysing', us: 'analyzing', endings: [''], canada: 'us' },
    { uk: 'paralyse', us: 'paralyze', endings: ['', 's', 'd'], canada: 'us' },
    { uk: 'paralysing', us: 'paralyzing', endings: [''], canada: 'us' },
    // single words
    { uk: 'grey', us: 'gray', endings: ['', 's', 'er', 'est', 'ish', 'ness'], canada: 'both' },
    { uk: 'plough', us: 'plow', endings: ['', 's', 'ed', 'ing'], canada: 'both' },
    { uk: 'mould', us: 'mold', endings: ['', 's', 'ed', 'ing', 'y'], canada: 'uk' },
    { uk: 'moustache', us: 'mustache', endings: ['', 's', 'd'], canada: 'both' },
    { uk: 'pyjamas', us: 'pajamas', endings: [''], canada: 'uk' },
    { uk: 'aluminium', us: 'aluminum', endings: [''], canada: 'us' },
    { uk: 'aeroplane', us: 'airplane', endings: ['', 's'], canada: 'us' },
    { uk: 'sceptic', us: 'skeptic', endings: ['', 's', 'al', 'ally', 'ism'], canada: 'us' },
    { uk: 'catalogue', us: 'catalog', endings: ['', 's'], canada: 'uk' },
    { uk: 'cosy', us: 'cozy', endings: [''], canada: 'us' },
    { uk: 'cosier', us: 'cozier', endings: [''], canada: 'us' },
];

export interface VariantHit {
    /** The form preferred by the sheet's variety. */
    preferred: string;
}

/** form → [the other variety's form, the family]: built once. */
const BY_FORM: ReadonlyMap<string, { other: string; side: 'uk' | 'us'; canada: CanadianForm }> = (() => {
    const m = new Map<string, { other: string; side: 'uk' | 'us'; canada: CanadianForm }>();
    for (const f of FAMILIES) {
        for (const e of f.endings) {
            m.set(f.uk + e, { other: f.us + e, side: 'uk', canada: f.canada });
            m.set(f.us + e, { other: f.uk + e, side: 'us', canada: f.canada });
        }
    }
    return m;
})();

/** How many forms the list holds (both varieties, every ending). */
export const SPELLING_VARIANT_FORMS = BY_FORM.size;

/** The preferred form when `word` (lower case) is the OTHER variety's spelling under `spelling`, else null. */
export function variantFor(word: string, spelling: StyleSpelling): VariantHit | null {
    const hit = BY_FORM.get(word);
    if (!hit) return null;
    const wanted: 'uk' | 'us' | 'both' = spelling === 'american' ? 'us' : spelling === 'canadian' ? hit.canada : 'uk';
    if (wanted === 'both' || wanted === hit.side) return null;
    return { preferred: hit.other };
}

/** `replacement` in the case pattern of `original` (all capitals, a capital first letter, or lower case). */
export function inCaseOf(original: string, replacement: string): string {
    if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return replacement.toUpperCase();
    const first = original.charAt(0);
    if (first !== first.toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
}
