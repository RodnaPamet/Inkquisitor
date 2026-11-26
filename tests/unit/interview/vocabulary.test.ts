/**
 * The question engine's client-safe vocabularies equal their Prisma enums,
 * in order (`src/lib/interview/vocabulary.ts`), and the database's persona
 * CHECK names exactly the six persona keys.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $Enums } from '@prisma/client';
import { ANSWER_STATUSES, INTERVIEW_SCOPES, INTERVIEW_STATUSES, PERSONA_KEYS, QUESTION_KINDS, QUESTION_MODES, QUESTION_ORIGINS, ROUND_STATUSES, STOP_REASONS, isPanelPersona } from '@/lib/interview/vocabulary';
import { REPO_ROOT, repoRelativeFiles } from '../../helpers/repo-files';

it.each([
    ['InterviewScope', INTERVIEW_SCOPES, $Enums.InterviewScope],
    ['InterviewStatus', INTERVIEW_STATUSES, $Enums.InterviewStatus],
    ['InterviewStopReason', STOP_REASONS, $Enums.InterviewStopReason],
    ['InterviewRoundStatus', ROUND_STATUSES, $Enums.InterviewRoundStatus],
    ['QuestionKind', QUESTION_KINDS, $Enums.QuestionKind],
    ['QuestionMode', QUESTION_MODES, $Enums.QuestionMode],
    ['QuestionOrigin', QUESTION_ORIGINS, $Enums.QuestionOrigin],
    ['AnswerStatus', ANSWER_STATUSES, $Enums.AnswerStatus],
] as const)('%s', (_name, list, prismaEnum) => {
    expect([...list]).toEqual(Object.values(prismaEnum));
});

it('the newest migration’s session persona CHECK names exactly the persona keys (Phase 4.3: the panel joined)', () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'prisma/migrations/20261128100000_book_interrogation/migration.sql'), 'utf8');
    const m = /"personaKeys" <@ ARRAY\[([^\]]+)\]/.exec(sql);
    expect(m![1].split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...PERSONA_KEYS]);
});

it('the defaults’ persona CHECK names every persona but the panel’s (D29: the panel is never a default)', () => {
    // The newest definition of the defaults' list function is the one in force.
    const defining = repoRelativeFiles()
        .filter((f) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(f))
        .sort()
        .filter((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes('FUNCTION interview_persona_list_ok'));
    expect(defining.length).toBeGreaterThan(0);
    const sql = fs.readFileSync(path.join(REPO_ROOT, defining[defining.length - 1]), 'utf8');
    const j = /list <@ '\[([^\]]+)\]'::jsonb/.exec(sql);
    expect(j![1].split(',').map((s) => s.trim().replace(/"/g, ''))).toEqual(PERSONA_KEYS.filter((k) => !isPanelPersona(k)));
});
