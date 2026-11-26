/**
 * The question engine's client-safe vocabularies equal their Prisma enums,
 * in order (`src/lib/interview/vocabulary.ts`), and the database's persona
 * CHECK names exactly the six persona keys.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $Enums } from '@prisma/client';
import { ANSWER_STATUSES, INTERVIEW_SCOPES, INTERVIEW_STATUSES, PERSONA_KEYS, QUESTION_KINDS, QUESTION_MODES, QUESTION_ORIGINS, ROUND_STATUSES, STOP_REASONS } from '@/lib/interview/vocabulary';
import { REPO_ROOT } from '../../helpers/repo-files';

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

it('the newest migration’s persona CHECKs name exactly the persona keys (Phase 4.3: the panel joined)', () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'prisma/migrations/20261128100000_book_interrogation/migration.sql'), 'utf8');
    const m = /"personaKeys" <@ ARRAY\[([^\]]+)\]/.exec(sql);
    expect(m![1].split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...PERSONA_KEYS]);
    const j = /list <@ '\[([^\]]+)\]'::jsonb/.exec(sql);
    expect(j![1].split(',').map((s) => s.trim().replace(/"/g, ''))).toEqual([...PERSONA_KEYS]);
});
