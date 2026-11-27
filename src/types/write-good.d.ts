/**
 * The part of write-good (MIT, btford/write-good) that the prose checks read
 * (`src/lib/prose-checks/rules/ported.ts`): one call over a text with every
 * check switched by name, answering each match's offset and length. write-good
 * ships no type declarations; this states only what is used, so a call outside
 * it fails `tsc` instead of passing as `any`.
 */
declare module 'write-good' {
    interface WriteGoodChecks {
        passive?: boolean;
        illusion?: boolean;
        so?: boolean;
        thereIs?: boolean;
        weasel?: boolean;
        adverb?: boolean;
        tooWordy?: boolean;
        cliches?: boolean;
        eprime?: boolean;
    }

    interface WriteGoodSuggestion {
        /** Offset of the match into the text. */
        index: number;
        /** The match's length. */
        offset: number;
        reason: string;
    }

    function writeGood(text: string, checks?: WriteGoodChecks): WriteGoodSuggestion[];
    export default writeGood;
}
