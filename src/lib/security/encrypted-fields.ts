/**
 * THE ENCRYPTED-FIELDS MANIFEST — which columns are encrypted at rest.
 *
 * The Prisma extension in `src/lib/db/encryption-middleware.ts` encrypts
 * every listed field on write (a `v2:` envelope under the workspace's data
 * key inside `runInWorkspaceContext`) and decrypts it on read. Callers never
 * see ciphertext and never call the primitives themselves.
 *
 * THE BIBLE'S AUTHOR TEXT (Phase 1.1, roadmap rule 4: author text is
 * encrypted at rest): a book's logline, an element's summary, every field
 * value, a relation's note, and a version's snapshot (the element and its
 * fields, serialised to one JSON string, `src/lib/bible/snapshot.ts`) and
 * change summary. Users, workspaces, memberships and the audit trail carry
 * identifiers, not content. Book titles, element names, slugs and custom
 * labels stay readable on purpose: lists sort by them and the slug is a
 * unique key (docs/implementation-notes/2026-11-19-1.1-bible-model.md).
 *
 * THE INTERVIEW'S TEXT (Phase 2.2): a question's text, options, scale
 * labels, recommended answer, rationale and challenge quote (generated from
 * the author's bible, and a challenge quotes it verbatim), and an answer's
 * text and choice. Options, scale labels and the recommendation are JSON
 * serialised to one string and sealed whole.
 *
 * Every listed field is ciphertext at rest and reads back in its own
 * workspace (`tests/integration/bible-encryption.test.ts`); the extension's
 * behaviour is also proved against a test manifest
 * (`tests/unit/security/encryption-extension.test.ts`,
 * `tests/integration/field-encryption.test.ts`), which is why it takes the
 * manifest as a parameter. Every listed field's write path sanitises it
 * first (`tests/guards/encrypted-field-sanitiser-coverage.test.ts`).
 *
 * Adding a field: list it here, in the same change as the column. A field is
 * a `String`/`String?` column; anything else passes through untouched.
 *
 * Adapted from inflect-compliance's `src/lib/security/encrypted-fields.ts`
 * (see docs/carve-manifest.md): the compliance entries are gone, and the
 * lookup helpers are compiled from a manifest value rather than module
 * constants, so a test manifest gets the same behaviour as the real one.
 */

/** Model name → the string fields encrypted at rest. */
export type EncryptedFieldManifest = Readonly<Record<string, readonly string[]>>;

export const ENCRYPTED_FIELDS: EncryptedFieldManifest = Object.freeze({
    Book: Object.freeze(['logline']),
    BibleElement: Object.freeze(['summary']),
    BibleField: Object.freeze(['value']),
    BibleRelation: Object.freeze(['note']),
    BibleEntryVersion: Object.freeze(['snapshot', 'changeSummary']),
    // Phase 3.3 (decision D24): a relation's fields and its version history.
    BibleRelationField: Object.freeze(['value']),
    BibleRelationVersion: Object.freeze(['snapshot', 'changeSummary']),
    Question: Object.freeze(['text', 'options', 'scaleLabels', 'recommendedAnswer', 'rationale', 'challengeQuote']),
    Answer: Object.freeze(['text', 'choice']),
    // Phase 2.5: a proposed value (drawn from the author's answers) and a proposed element's name and summary.
    EnrichmentProposal: Object.freeze(['proposedValue', 'newName', 'newSummary']),
    // Phase 2.6: a research brief, an attached file, a finding and its citations, a research proposal.
    ResearchBrief: Object.freeze(['question', 'purpose', 'sourceUrls']),
    ResearchSource: Object.freeze(['filename', 'text']),
    ResearchFinding: Object.freeze(['claim', 'summary', 'noFitReason']),
    ResearchCitation: Object.freeze(['url', 'title', 'quotedSpan']),
    ResearchProposal: Object.freeze(['proposedValue', 'newName', 'newSummary', 'rationale']),
    // Decision D15: every query and fetch URL a research run sent.
    ResearchEgress: Object.freeze(['text']),
    // Phase 3.1: a story map's freeform layer (sticky notes and loose text are author text) and each save's snapshot of the map.
    StoryMap: Object.freeze(['freeformJson']),
    MapSnapshot: Object.freeze(['snapshot']),
    // Phase 4.0 (D23, D26): a source's file name, a chunk's passage and headings, a fact's words, a book's override.
    Source: Object.freeze(['filename']),
    SourceChunk: Object.freeze(['text', 'headingPath']),
    StoryFact: Object.freeze(['subjectName', 'objectLiteral', 'statement', 'quote', 'storyTimeFrom', 'storyTimeTo']),
    StoryFactOverride: Object.freeze(['text']),
    // Phase 4.2 (D28): the registries' entries and the threads the product proposes (the quote is the version's words).
    StoryThread: Object.freeze(['title', 'note']),
    StoryThreadProposal: Object.freeze(['title', 'quote']),
    // Phase 4.3 (D29): a stress test's weak points (label and questions), a gap hunt's picks (the reasons), a long
    // session's summary of its earlier rounds.
    StressWeakPoint: Object.freeze(['title', 'questions']),
    GapHunt: Object.freeze(['picks']),
    InterviewCompaction: Object.freeze(['summary']),
    // Phase 5.1 (D33): the manuscript — titles, a scene's prose, story time and note, and every version of the text and the note.
    ManuscriptPart: Object.freeze(['title']),
    ManuscriptChapter: Object.freeze(['title']),
    ManuscriptScene: Object.freeze(['title', 'text', 'storyTime', 'note']),
    SceneVersion: Object.freeze(['text']),
    SceneNoteVersion: Object.freeze(['note']),
    // Phase 5.2 (D34): a prose finding's detail (the words it is about, its suggestion) and the book's word baseline.
    ProseFinding: Object.freeze(['detail']),
    ProseBookBaseline: Object.freeze(['baseline']),
});

/** The lookups the extension runs per operation, compiled once per manifest. */
export interface CompiledManifest {
    fieldsOf(model: string): readonly string[] | undefined;
    isEncryptedModel(model: string): boolean;
    isEmpty: boolean;
}

export function compileManifest(manifest: EncryptedFieldManifest): CompiledManifest {
    // A field is encrypted only on the model that lists it; there is no
    // model-less "any field of this name" lookup (a nested write is resolved
    // to its model through the schema's relations instead).
    const fieldCount = Object.values(manifest).reduce((n, fields) => n + fields.length, 0);
    return {
        fieldsOf: (model) => (Object.prototype.hasOwnProperty.call(manifest, model) ? manifest[model] : undefined),
        isEncryptedModel: (model) => Object.prototype.hasOwnProperty.call(manifest, model) && manifest[model].length > 0,
        isEmpty: fieldCount === 0,
    };
}
