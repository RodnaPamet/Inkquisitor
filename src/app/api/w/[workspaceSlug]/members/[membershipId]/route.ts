/**
 * PATCH  /api/w/:workspaceSlug/members/:membershipId  { role } — change a member's role
 * DELETE /api/w/:workspaceSlug/members/:membershipId           — remove a member
 *
 * Both need `members.manage` (OWNER). A workspace always keeps one OWNER
 * (409, `reason: LAST_OWNER`).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { changeMemberRole, removeMember } from '@/app-layer/usecases/members';

type Params = { workspaceSlug: string; membershipId: string };

const RoleBody = z.object({ role: z.enum(['OWNER', 'EDITOR', 'READER']) }).strict();

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('members.manage', async (req, { params }, ctx) => {
        const { role } = RoleBody.parse(await req.json());
        return NextResponse.json(await changeMemberRole(ctx, params.membershipId, role));
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('members.manage', async (_req, { params }, ctx) => NextResponse.json(await removeMember(ctx, params.membershipId))),
);
