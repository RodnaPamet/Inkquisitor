/**
 * The question engine's client-safe vocabularies equal their Prisma enums,
 * in order (`src/lib/interview/vocabulary.ts`), and the database's persona
 * CHECK names exactly the six persona keys.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { $Enums } from '@prisma/client';
import {
    ANSWER_STATUSES,
    INTERVIEW_LENGTH_MODES,
    INTERVIEW_SCOPES,
    INTERVIEW_STATUSES,
    LADDER_LAYERS,
    PAIR_ANGLES,
    PERSONA_KEYS,
    QUESTION_GENERATORS,
    QUESTION_KINDS,
    QUESTION_MODES,
    QUESTION_ORIGINS,
    ROUND_STATUSES,
    STOP_REASONS,
    isPanelPersona,
} from '@/lib/interview/vocabulary';
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
    ['QuestionGenerator', QUESTION_GENERATORS, $Enums.QuestionGenerator],
    ['InterviewLengthMode', INTERVIEW_LENGTH_MODES, $Enums.InterviewLengthMode],
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

it('Phase 4.4: the migration’s CHECKs name exactly the generators, the ladder’s layers and the pairs’ angles (D30)', () => {
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'prisma/migrations/20261129110000_continuous_questioning/migration.sql'), 'utf8');
    const list = (re: RegExp) => re.exec(sql)![1].split(',').map((x) => x.trim().replace(/['"]/g, ''));
    expect(list(/"generatorsOff" <@ ARRAY\[([^\]]+)\]/)).toEqual([...QUESTION_GENERATORS]);
    expect(list(/list <@ '\[([^\]]+)\]'::jsonb/)).toEqual([...QUESTION_GENERATORS]);
    expect(list(/"generator" = 'LADDER' AND "angle" IN \(([^)]+)\)/)).toEqual([...LADDER_LAYERS]);
    expect(list(/"generator" = 'RELATIONS' AND "angle" IN \(([^)]+)\)/)).toEqual([...PAIR_ANGLES]);
});
