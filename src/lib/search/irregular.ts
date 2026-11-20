/**
 * Irregular English forms the stemmer cannot reach (Phase 3.4, decision
 * D21): a small, REVIEWED table laid over Porter2 (`porter2.ts`). A surface
 * form listed here is stemmed as its lemma, so "went" and "gone" find "go",
 * "ran" finds "running", "mice" finds "mouse".
 *
 * The rule for an entry: the surface form is, in a novel's prose, almost
 * always the form of that lemma. Forms that are just as often another word
 * are LEFT OUT, because merging them would make a search find the wrong word
 * silently: "left" (a direction), "saw" (a tool), "rose" (a flower and a
 * name), "fell" (a hill, to fell a tree, a name), "lay", "bore", "bit",
 * "lit", "dove", "ground", "bound", "wound", "lives" and "leaves" (verbs as
 * often as plurals), "does" (deer). Comparatives (better → good) are left out
 * too: a search for "better" should not find every "good".
 *
 * `tests/unit/search/irregular.test.ts` holds the table to that shape: every
 * entry changes the stem it would otherwise get, no lemma is itself a
 * surface form (no chains), keys are folded lower case, and no key is a
 * search stop word.
 */

import { porter2Stem } from './porter2';

/** Moves whenever the table changes. */
export const IRREGULAR_FORMS_VERSION = 'irregular-1';

const TABLE: Readonly<Record<string, readonly string[]>> = {
    // verbs: lemma → its irregular past and participle forms
    arise: ['arose', 'arisen'],
    awake: ['awoke', 'awoken'],
    become: ['became'],
    begin: ['began', 'begun'],
    bend: ['bent'],
    bite: ['bitten'],
    bleed: ['bled'],
    break: ['broke', 'broken'],
    bring: ['brought'],
    build: ['built'],
    burn: ['burnt'],
    buy: ['bought'],
    catch: ['caught'],
    choose: ['chose', 'chosen'],
    cling: ['clung'],
    come: ['came'],
    creep: ['crept'],
    deal: ['dealt'],
    dig: ['dug'],
    do: ['did', 'done'],
    draw: ['drew', 'drawn'],
    dream: ['dreamt'],
    drink: ['drank', 'drunk'],
    drive: ['drove', 'driven'],
    eat: ['ate', 'eaten'],
    fall: ['fallen'],
    feed: ['fed'],
    feel: ['felt'],
    fight: ['fought'],
    find: ['found'],
    flee: ['fled'],
    fling: ['flung'],
    fly: ['flew', 'flown'],
    forbid: ['forbade', 'forbidden'],
    foresee: ['foresaw', 'foreseen'],
    forget: ['forgot', 'forgotten'],
    forgive: ['forgave', 'forgiven'],
    freeze: ['froze', 'frozen'],
    give: ['gave', 'given'],
    go: ['went', 'gone', 'goes'],
    grow: ['grew', 'grown'],
    hang: ['hung'],
    hear: ['heard'],
    hide: ['hid', 'hidden'],
    hold: ['held'],
    keep: ['kept'],
    kneel: ['knelt'],
    know: ['knew', 'known'],
    lay: ['laid'],
    leap: ['leapt'],
    lend: ['lent'],
    lose: ['lost'],
    make: ['made'],
    mean: ['meant'],
    meet: ['met'],
    mistake: ['mistook', 'mistaken'],
    overcome: ['overcame'],
    pay: ['paid'],
    ride: ['rode', 'ridden'],
    ring: ['rang', 'rung'],
    run: ['ran'],
    say: ['said'],
    see: ['seen'],
    seek: ['sought'],
    sell: ['sold'],
    send: ['sent'],
    shake: ['shook', 'shaken'],
    shine: ['shone'],
    shoot: ['shot'],
    sing: ['sang', 'sung'],
    sink: ['sank', 'sunk'],
    sit: ['sat'],
    slay: ['slew', 'slain'],
    sleep: ['slept'],
    slide: ['slid'],
    speak: ['spoke', 'spoken'],
    speed: ['sped'],
    spend: ['spent'],
    spin: ['spun'],
    stand: ['stood'],
    steal: ['stole', 'stolen'],
    sting: ['stung'],
    strike: ['struck', 'stricken'],
    strive: ['strove', 'striven'],
    swear: ['swore', 'sworn'],
    sweep: ['swept'],
    swim: ['swam', 'swum'],
    swing: ['swung'],
    take: ['took', 'taken'],
    teach: ['taught'],
    tear: ['tore', 'torn'],
    tell: ['told'],
    think: ['thought'],
    throw: ['threw', 'thrown'],
    undertake: ['undertook', 'undertaken'],
    understand: ['understood'],
    wake: ['woke', 'woken'],
    wear: ['wore', 'worn'],
    weave: ['wove', 'woven'],
    weep: ['wept'],
    win: ['won'],
    withdraw: ['withdrew', 'withdrawn'],
    write: ['wrote', 'written'],
    // nouns: singular → irregular plural
    calf: ['calves'],
    child: ['children'],
    elf: ['elves'],
    foot: ['feet'],
    goose: ['geese'],
    half: ['halves'],
    knife: ['knives'],
    loaf: ['loaves'],
    man: ['men'],
    mouse: ['mice'],
    ox: ['oxen'],
    shelf: ['shelves'],
    thief: ['thieves'],
    tooth: ['teeth'],
    wife: ['wives'],
    wolf: ['wolves'],
    woman: ['women'],
};

/** Surface form → lemma. */
export const IRREGULAR_FORMS: ReadonlyMap<string, string> = new Map(
    Object.entries(TABLE).flatMap(([lemma, forms]) => forms.map((f) => [f, lemma] as const)),
);

/** The lemma a folded surface form stems as, or the form itself. */
export function lemmaOf(surface: string): string {
    return IRREGULAR_FORMS.get(surface) ?? surface;
}

/**
 * For each stem a lemma of the table has, the irregular forms that stem as it
 * ("go" → went, gone, goes): what a source must contain, beside the stem's
 * own prefix, to hold a word of that stem (`rank.ts`). Built once from the
 * table, which is product data.
 */
export const IRREGULAR_SURFACES_BY_STEM: ReadonlyMap<string, readonly string[]> = (() => {
    const out = new Map<string, string[]>();
    for (const [surface, lemma] of IRREGULAR_FORMS) {
        const stem = porter2Stem(lemma);
        out.set(stem, [...(out.get(stem) ?? []), surface]);
    }
    return out;
})();
