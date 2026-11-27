/**
 * The full export's archive layout (Phase 5.H-a, D36): every file it holds, where, and the README's sentence for it.
 * ONE table, read by the writer (`usecases/workspace-export.ts`) and the README, so a file the archive holds is always
 * described and a description never names a file that is not there (`tests/unit/export/archive-layout.test.ts`).
 *
 * FORMAT VERSION 1. A book's folder is `books/<NN>-<slug>/`; JSON Lines files (`.jsonl`) hold one row a line, every
 * column of it (dates as ISO strings, money in micro-US-dollars as a decimal string, a version's snapshot as JSON).
 */
import type { BookExportTable } from '@/app-layer/repositories/export.repository';

export const EXPORT_FORMAT = 'inkquisitor-export';
export const EXPORT_FORMAT_VERSION = 1;

export interface BookTableFile {
    table: BookExportTable;
    /** Path inside the book's folder. */
    path: string;
    /** Rows a page (a scene version can be a whole scene). */
    page: number;
    describe: string;
}

export const BOOK_TABLE_FILES: readonly BookTableFile[] = [
    { table: 'bibleVersions', path: 'history/bible-versions.jsonl', page: 100, describe: 'Every saved version of every bible entry, oldest first by id: its snapshot (the entry as it stood), where it came from (your edit, an interview answer, research, an import, the manuscript) and the answers it names. Each entry’s newest version is its current state.' },
    { table: 'relationVersions', path: 'history/relation-versions.jsonl', page: 100, describe: 'Every saved version of every relation’s fields.' },
    { table: 'sceneVersions', path: 'history/scene-versions.jsonl', page: 25, describe: 'Every kept version of every scene’s text (as the editor’s HTML), including scenes you have since deleted.' },
    { table: 'sceneNoteVersions', path: 'history/scene-note-versions.jsonl', page: 100, describe: 'Every version of every scene’s note, with the research findings an accepted note names.' },
    { table: 'sceneCardVersions', path: 'history/scene-card-versions.jsonl', page: 100, describe: 'Every version of every scene card (goal, conflict, outcome, what changed).' },
    { table: 'mapSnapshots', path: 'history/map-snapshots.jsonl', page: 50, describe: 'Every saved state of the relationship map, plot board and timeline (the canvas rows and your sticky notes).' },
    { table: 'interviewSessions', path: 'interviews/sessions.jsonl', page: 200, describe: 'Every interview session: its scope, settings, status and why it stopped.' },
    { table: 'interviewRounds', path: 'interviews/rounds.jsonl', page: 200, describe: 'Every round of every session.' },
    { table: 'questions', path: 'interviews/questions.jsonl', page: 200, describe: 'Every question you were asked, with the field it was about.' },
    { table: 'answers', path: 'interviews/answers.jsonl', page: 200, describe: 'Every answer you gave, every revision of it, and the ones you skipped or left for later.' },
    { table: 'enrichmentProposals', path: 'decisions/enrichment-proposals.jsonl', page: 200, describe: 'Every change an interview proposed to your bible, and your decision on it.' },
    { table: 'facts', path: 'decisions/facts.jsonl', page: 200, describe: 'Every fact recorded about the book — from your bible, your uploaded sources and your draft — with your decision on each source fact.' },
    { table: 'factProposals', path: 'decisions/fact-proposals.jsonl', page: 200, describe: 'Every contradiction, stale fact and draft-against-bible mismatch raised, and how you decided it.' },
    { table: 'threads', path: 'decisions/threads.jsonl', page: 200, describe: 'The book’s promises, clues and open questions, and their states.' },
    { table: 'threadSceneLinks', path: 'decisions/thread-scene-links.jsonl', page: 200, describe: 'The scenes proposed as planting or paying off a thread, and your decision on each.' },
    { table: 'researchBriefs', path: 'research/briefs.jsonl', page: 200, describe: 'Your research briefs: question, purpose, scope and depth.' },
    { table: 'researchSources', path: 'research/sources.jsonl', page: 100, describe: 'The URLs and files you attached to a brief (a file’s text as you uploaded it).' },
    { table: 'researchFindings', path: 'research/findings.jsonl', page: 200, describe: 'Every finding a research run made, with the quoted span it rests on.' },
    { table: 'researchProposals', path: 'decisions/research-proposals.jsonl', page: 200, describe: 'Every change research proposed (to the bible or a scene’s note), and your decision on it.' },
    { table: 'sources', path: 'sources/sources.jsonl', page: 200, describe: 'The files in the book’s source library: name, format, version and when you uploaded them (a file is kept only as the text chunks below).' },
    { table: 'sourceChunks', path: 'sources/chunks.jsonl', page: 100, describe: 'The text of your uploaded sources, as the chunks Inkquisitor keeps (the file itself is never stored).' },
    { table: 'stressTests', path: 'interviews/stress-tests.jsonl', page: 100, describe: 'Every stress test of the book and what it covered.' },
];

/** The other files of a book's folder. */
export const BOOK_FILES = {
    book: { path: 'book.json', describe: 'The book’s details: title, logline, genre, audience, target length and stage.' },
    bundle: { path: 'bible-bundle.zip', describe: 'The book bible as it stands, in the Markdown bundle format the bible export writes — byte for byte the same file — which Import takes back.' },
    docx: { path: 'manuscript/manuscript.docx', describe: 'The manuscript as a Word document: parts, chapters and scenes in order, with your emphasis.' },
    markdown: { path: 'manuscript/manuscript.md', describe: 'The manuscript as Markdown.' },
    outline: { path: 'manuscript/outline.json', describe: 'The manuscript’s structure: every part, chapter and scene with its title, word count, point of view, setting, story time, note, card and links to the bible and the plot beats.' },
} as const;

/** The archive's own files, at its root. */
export const ROOT_FILES = {
    readme: { path: 'README.md', describe: 'This file.' },
    manifest: { path: 'manifest.json', describe: 'The format, when the archive was made, and every file it holds with its row count.' },
    workspace: { path: 'workspace.json', describe: 'The workspace’s name and its members’ roles and names (never their email addresses).' },
    audit: { path: 'audit/audit-log.jsonl', describe: 'The workspace’s audit trail: who did what and when, as ids, counts and codes (it never holds your text).' },
    seriesSources: { path: 'series/sources.jsonl', describe: 'The workspace’s series library: the files shared across books.' },
    seriesChunks: { path: 'series/chunks.jsonl', describe: 'The text of the series library’s sources, as kept chunks.' },
    seriesFacts: { path: 'series/facts.jsonl', describe: 'The facts recorded from the series library, with your decisions.' },
} as const;

/** What the archive deliberately does not hold, said in its README. */
export const NOT_INCLUDED: readonly string[] = [
    'Books and scenes in Recently deleted: restore one before you export it (a deleted scene’s versions are in its book’s history all the same).',
    'Embeddings (vectors): numbers derived from your text, made again from it.',
    'Prose-check notes and the nightly readings’ bookkeeping: worked out again from your text.',
    'Model-call records: what each call cost and how it ended, holding no text.',
];
