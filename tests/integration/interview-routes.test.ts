/**
 * The interview routes (Phase 2.2), called as Next calls them, with the
 * session as the one seam (`auth()`) and the model seam
 * (`src/lib/interview/model-seam.ts`) the other: unmocked it is the
 * deployment's — NOT WIRED until 2.1 — and the routes that would generate
 * questions answer 503 MODEL_NOT_WIRED writing nothing; given the
 * deterministic fake, a whole interview runs over HTTP. Signed out, stranger
 * and READER are tests/integration/api-route-authorization.test.ts.
 */
const session: { userId: string | null } = { userId: null };
jest.mock('@/auth', () => ({
    auth: async () => (session.userId ? { user: { id: session.userId, email: 'x@example.test', name: null }, expires: '' } : null),
}));

const seam: { generator: import('@/lib/interview/generator').QuestionGenerator | null } = { generator: null };
jest.mock('@/lib/interview/model-seam', () => {
    const actual = jest.requireActual<typeof import('@/lib/interview/model-seam')>('@/lib/interview/model-seam');
    return { ...actual, defaultQuestionGenerator: () => seam.generator ?? actual.defaultQuestionGenerator() };
});

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { createElement } from '@/app-layer/usecases/bible-elements';
import { createBook } from '@/app-layer/usecases/books';
import { GET as listRoute, POST as startRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/route';
import { GET as getRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/route';
import { POST as roundsRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/rounds/route';
import { POST as closeRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/rounds/[roundNumber]/close/route';
import { POST as stopRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/stop/route';
import { POST as answerRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/questions/[questionId]/answer/route';
import { POST as skipRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/questions/[questionId]/skip/route';
import { POST as laterRoute } from '@/app/api/w/[workspaceSlug]/books/[bookId]/interviews/[sessionId]/questions/[questionId]/decide-later/route';
import type { InterviewView, QuestionView } from '@/app-layer/usecases/interview-state';
import { fakeGenerator } from '../helpers/fake-question-generator';
import { createAccount, workspaceCtx } from '../helpers/workspaces';

afterAll(() => prisma.$disconnect());

let owner: Awaited<ReturnType<typeof createAccount>>;
let bookId: string;
let elementId: string;

beforeAll(async () => {
    owner = await createAccount();
    session.userId = owner.userId;
    const ctx = workspaceCtx(owner);
    bookId = (await createBook(ctx, { title: 'Ferry Nights' })).id;
    elementId = (await createElement(ctx, bookId, { kind: 'CHARACTER', name: 'Odile' })).id;
});

/** Any of the route handlers: each takes its own params, which `call` supplies whole. */
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;

async function call(handler: Handler, path: string, params: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = new NextRequest(`http://localhost/api/w/${owner.workspaceSlug}/books/${bookId}/interviews${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.32' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handler(req, { params: Promise.resolve({ workspaceSlug: owner.workspaceSlug, bookId, ...params }) as Promise<never> });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function answerFor(q: QuestionView): Record<string, unknown> {
    if (q.kind === 'CHOICE' || q.kind === 'EITHER_OR') return { choice: q.options![0] };
    if (q.kind === 'SCALE') return { scale: 4 };
    return { text: 'She will not let the ferry go for scrap.' };
}

it('refuses 503 MODEL_NOT_WIRED while no model is wired, and writes nothing', async () => {
    seam.generator = null;
    const before = await prisma.interviewSession.count({ where: { bookId } });
    const res = await call(startRoute, '', {}, { scope: 'ELEMENT', elementId });
    expect(res.status).toBe(503);
    expect(res.json.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { reason: 'MODEL_NOT_WIRED' } });
    expect(await prisma.interviewSession.count({ where: { bookId } })).toBe(before);
});

it('runs a whole interview over HTTP with a wired generator', async () => {
    seam.generator = fakeGenerator();
    const started = await call(startRoute, '', {}, { scope: 'ELEMENT', elementId, depth: 2, detail: 3 });
    expect(started.status).toBe(201);
    const view = started.json.interview as InterviewView;
    const sessionId = view.session.id;
    const [first, second, ...rest] = view.round!.questions;
    expect(first).toBeDefined();

    expect((await call(answerRoute, `/${sessionId}/questions/${first.id}/answer`, { sessionId, questionId: first.id }, answerFor(first))).status).toBe(201);
    if (second) expect((await call(skipRoute, `/${sessionId}/questions/${second.id}/skip`, { sessionId, questionId: second.id }, {})).status).toBe(201);
    for (const q of rest) expect((await call(laterRoute, `/${sessionId}/questions/${q.id}/decide-later`, { sessionId, questionId: q.id }, {})).status).toBe(201);

    // A malformed answer body is a 400, never a 500.
    expect((await call(answerRoute, `/${sessionId}/questions/${first.id}/answer`, { sessionId, questionId: first.id }, { colour: 'blue' })).status).toBe(400);

    const closed = await call(closeRoute, `/${sessionId}/rounds/1/close`, { sessionId, roundNumber: '1' }, {});
    expect(closed.status).toBe(200);
    expect((await call(closeRoute, `/${sessionId}/rounds/99999999999/close`, { sessionId, roundNumber: '99999999999' }, {})).status).toBe(400);

    const next = await call(roundsRoute, `/${sessionId}/rounds`, { sessionId }, {});
    expect(next.status).toBe(201);
    expect((next.json.interview as InterviewView).round!.number).toBe(2);

    const read = await call(getRoute, `/${sessionId}`, { sessionId });
    expect(read.status).toBe(200);
    expect((read.json.interview as InterviewView).progress).toMatchObject({ status: 'MEASURED' });
    const list = await call(listRoute, '', {});
    expect((list.json.sessions as Array<{ id: string }>).some((s) => s.id === sessionId)).toBe(true);

    const stopped = await call(stopRoute, `/${sessionId}/stop`, { sessionId }, {});
    expect((stopped.json.interview as InterviewView).session).toMatchObject({ status: 'STOPPED', stopReason: 'AUTHOR_STOPPED' });
    expect((await call(stopRoute, `/${sessionId}/stop`, { sessionId }, {})).status).toBe(409);
});
