/**
 * POST /api/auth/register — credentials sign-up: a new account, a new
 * workspace, and the account as its OWNER (`signUpWithPassword`). Signs
 * nobody in: the page signs in through the Credentials provider afterwards.
 *
 * Unauthenticated by design (it is how an account comes to exist); bounded by
 * the edge auth tier and `WORKSPACE_CREATE_LIMIT` (5 an hour per address).
 * A refusal carries `error.details.reason` (`SignUpRefusal`) for the page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { readJsonBody } from '@/lib/http/json-body';
import { WORKSPACE_CREATE_LIMIT } from '@/lib/security/rate-limit';
import { MAX_PASSWORD_LENGTH } from '@/lib/auth/password-limits';
import { signUpWithPassword } from '@/app-layer/usecases/sign-up';

const SignUpBody = z
    .object({
        email: z.string().trim().email().max(254),
        // The policy (length) is the usecase's, so its refusal carries a reason code.
        password: z.string().max(MAX_PASSWORD_LENGTH * 4),
        name: z.string().trim().max(120).optional(),
        workspaceName: z.string().trim().max(80).optional(),
    })
    .strict();

export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const body = SignUpBody.parse(await readJsonBody(req));
        const created = await signUpWithPassword(body, { requestId: req.headers.get('x-request-id') ?? undefined });
        return NextResponse.json({ workspaceSlug: created.workspaceSlug }, { status: 201 });
    },
    { rateLimit: { config: WORKSPACE_CREATE_LIMIT, scope: 'sign-up' } },
);
