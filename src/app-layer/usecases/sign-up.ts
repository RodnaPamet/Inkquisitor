/**
 * Sign-up: a new person gets a new workspace, as its OWNER (owner decision
 * D4: one workspace per author). Two ways in, one provisioning path:
 *
 *   signUpWithPassword      the credentials form (POST /api/auth/register).
 *                           Password policy, the breached-password check, a
 *                           bcrypt hash, then `provisionAccountWithWorkspace`.
 *   resolveGoogleSignIn     the Google `signIn` callback (src/auth.ts). Links
 *                           a vouched Google identity to an existing account,
 *                           or provisions a new one.
 *
 * `provisionAccountWithWorkspace` is ONE transaction. As the owning role it
 * creates the user (and the Google link) and the workspace with its data key
 * (`createWorkspaceWithDek`); then it switches the same transaction into the
 * new workspace's row-level security (`bindWorkspaceInTransaction`) and
 * writes the OWNER membership and the audit rows (USER_SIGNED_UP,
 * WORKSPACE_CREATED, MEMBERSHIP_CREATED) as app_user, under the policies a
 * running request is under. Any failure rolls all of it back: there is never
 * a user without a workspace, a workspace without an owner or a key, or an
 * unrecorded sign-up. `tests/integration/sign-up.test.ts` holds that.
 *
 * Sign-up alone signs nobody in. The client signs in afterwards through the
 * Credentials provider, so a session is minted in exactly one place.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '@/env';
import { appendAuditEntryWithin } from '@/lib/audit/audit-writer';
import { recordUserAuthEvent } from '@/lib/audit/user-auth-events';
import { runWithDbContext } from '@/lib/db/db-context';
import { bindWorkspaceInTransaction, runWithoutRls, type PrismaTx } from '@/lib/db/rls-middleware';
import { workspaceKeys } from '@/lib/db';
import { hashPassword, validatePasswordPolicy, type PasswordPolicyFailure } from '@/lib/auth/passwords';
import { normaliseEmail } from '@/lib/auth/credentials';
import { checkPasswordAgainstHIBP, type BreachedPasswordCheckResult } from '@/lib/security/password-check';
import { ConflictError, ForbiddenError, ValidationError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { cleanLine } from '@/lib/text-utils';
import { MembershipRepository } from '@/app-layer/repositories/membership.repository';
import { UserRepository } from '@/app-layer/repositories/user.repository';
import { WorkspaceRepository, createWorkspaceWithDek } from '@/app-layer/repositories/workspace.repository';

/** Why sign-up refused, as a code a page can translate (sent in `error.details.reason`). */
export type SignUpRefusal =
    | 'PASSWORD_EMPTY'
    | 'PASSWORD_TOO_SHORT'
    | 'PASSWORD_TOO_LONG'
    | 'PASSWORD_BREACHED'
    | 'EMAIL_ALREADY_REGISTERED';

const POLICY_REFUSAL: Record<PasswordPolicyFailure, SignUpRefusal> = {
    empty: 'PASSWORD_EMPTY',
    too_short: 'PASSWORD_TOO_SHORT',
    too_long: 'PASSWORD_TOO_LONG',
};

export interface ProvisionedAccount {
    userId: string;
    workspaceId: string;
    workspaceSlug: string;
}

// ─── Slugs ──────────────────────────────────────────────────────────

const SLUG_MAX = 40;

/** A URL-safe slug from free text: lower-case ASCII letters, digits and single hyphens. */
export function slugify(text: string): string {
    const slug = text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX)
        .replace(/-+$/g, '');
    return slug.length >= 2 ? slug : 'workspace';
}

function withSuffix(base: string): string {
    return `${base.slice(0, SLUG_MAX - 7)}-${randomBytes(3).toString('hex')}`;
}

function isUniqueViolation(err: unknown, field: string): boolean {
    if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    if (Array.isArray(target)) return target.includes(field);
    if (typeof target === 'string') return target.includes(field);
    // Driver-adapter errors may not name the target; the caller decides by what it checked.
    return true;
}

// ─── The one provisioning path ──────────────────────────────────────

export interface ProvisionInput {
    email: string;
    name: string | null;
    passwordHash: string | null;
    emailVerified: Date | null;
    image?: string | null;
    workspaceName: string;
    /** A Google identity to link in the same transaction. */
    google?: { providerAccountId: string };
    requestId?: string;
}

async function provisionOnce(input: ProvisionInput, slug: string, requestId: string): Promise<ProvisionedAccount> {
    return runWithoutRls({ reason: 'workspace-creation' }, (client) =>
        client.$transaction(async (tx) => {
            const user = await UserRepository.create(tx, {
                email: input.email,
                name: input.name,
                passwordHash: input.passwordHash,
                emailVerified: input.emailVerified,
                image: input.image ?? null,
            });
            if (input.google) {
                await UserRepository.linkAccount(tx, {
                    userId: user.id,
                    provider: 'google',
                    providerAccountId: input.google.providerAccountId,
                    type: 'oauth',
                });
            }
            const { workspace, dek } = await createWorkspaceWithDek(tx, { name: input.workspaceName, slug });
            // The key travels in the database context, so the encryption
            // extension never looks it up: the workspace is not committed for
            // the key manager's own connection to read, and that lookup would
            // need a second connection while this transaction holds one. It is
            // also primed for the requests that follow; a rollback leaves a
            // cached key for an id that will never exist, which is harmless.
            workspaceKeys.prime(workspace.id, dek);

            await bindWorkspaceInTransaction(tx, { workspaceId: workspace.id, requestId });
            await runWithDbContext({ workspaceId: workspace.id, actorUserId: user.id, requestId, source: 'workspace', deks: { primary: dek, previous: null } }, async () => {
                const membership = await MembershipRepository.create(tx, { workspaceId: workspace.id, userId: user.id, role: 'OWNER' });
                await writeSignUpAudit(tx, {
                    workspaceId: workspace.id,
                    userId: user.id,
                    membershipId: membership.id,
                    method: input.google ? 'google' : 'credentials',
                    requestId,
                });
            });
            return { userId: user.id, workspaceId: workspace.id, workspaceSlug: workspace.slug };
        }),
    );
}

async function writeSignUpAudit(
    tx: PrismaTx,
    ids: { workspaceId: string; userId: string; membershipId: string; method: 'credentials' | 'google'; requestId: string },
): Promise<void> {
    const base = { workspaceId: ids.workspaceId, actorUserId: ids.userId, actorType: 'USER' as const, requestId: ids.requestId };
    await appendAuditEntryWithin(tx, { ...base, action: 'USER_SIGNED_UP', entityType: 'User', entityId: ids.userId, detailsJson: { method: ids.method } });
    await appendAuditEntryWithin(tx, { ...base, action: 'WORKSPACE_CREATED', entityType: 'Workspace', entityId: ids.workspaceId, detailsJson: {} });
    await appendAuditEntryWithin(tx, {
        ...base,
        action: 'MEMBERSHIP_CREATED',
        entityType: 'WorkspaceMembership',
        entityId: ids.membershipId,
        detailsJson: { userId: ids.userId, role: 'OWNER' },
    });
}

/**
 * Create a person, their workspace (with its data key) and their OWNER
 * membership, atomically. Retries with a suffixed slug when another sign-up
 * took the slug first.
 */
export async function provisionAccountWithWorkspace(input: ProvisionInput): Promise<ProvisionedAccount> {
    const requestId = input.requestId ?? randomUUID();
    const base = slugify(input.workspaceName);
    let slug = (await runWithoutRls({ reason: 'workspace-discovery' }, (db) => WorkspaceRepository.slugTaken(db, base)))
        ? withSuffix(base)
        : base;
    for (let attempt = 0; ; attempt++) {
        try {
            return await provisionOnce(input, slug, requestId);
        } catch (err) {
            if (isUniqueViolation(err, 'email')) {
                const taken = await runWithoutRls({ reason: 'auth-identity' }, (db) => UserRepository.findByEmail(db, input.email));
                if (taken) throw new ConflictError('An account with this email already exists.', { reason: 'EMAIL_ALREADY_REGISTERED' });
            }
            if (attempt < 3 && isUniqueViolation(err, 'slug')) {
                slug = withSuffix(base);
                continue;
            }
            throw err;
        }
    }
}

// ─── Password sign-up ───────────────────────────────────────────────

export interface SignUpInput {
    email: string;
    password: string;
    name?: string | null;
    workspaceName?: string | null;
}

export interface SignUpDeps {
    /** The breached-password check. Defaults to the HIBP range API; tests pass a stub. */
    breachCheck?: (password: string) => Promise<BreachedPasswordCheckResult>;
    requestId?: string;
}

function defaultWorkspaceName(name: string | null, email: string): string {
    const who = name || cleanLine(email.split('@')[0] ?? '') || 'My';
    return `${who}'s workspace`.slice(0, 80);
}

export async function signUpWithPassword(input: SignUpInput, deps: SignUpDeps = {}): Promise<ProvisionedAccount> {
    const email = normaliseEmail(input.email);
    // Control characters out (#17): a NUL in either name was a 500.
    const name = (input.name && cleanLine(input.name)) || null;

    const policy = validatePasswordPolicy(input.password);
    if (!policy.ok) {
        throw new ValidationError('The password does not meet the policy.', { reason: POLICY_REFUSAL[policy.reason] });
    }

    if (env.PASSWORD_BREACH_CHECK !== 'off') {
        const check = deps.breachCheck ?? ((pw: string) => checkPasswordAgainstHIBP(pw));
        const result = await check(input.password);
        if (result.breached) {
            throw new ValidationError('This password has appeared in a data breach. Choose another.', { reason: 'PASSWORD_BREACHED' });
        }
        if ('skipped' in result) {
            // Fails open: an outage at the breach list must not stop sign-ups.
            logger.warn('sign-up.breach_check_skipped', { component: 'sign-up', reason: result.reason });
        }
    }

    const existing = await runWithoutRls({ reason: 'auth-identity' }, (db) => UserRepository.findByEmail(db, email));
    if (existing) {
        throw new ConflictError('An account with this email already exists.', { reason: 'EMAIL_ALREADY_REGISTERED' });
    }

    const passwordHash = await hashPassword(input.password);
    return provisionAccountWithWorkspace({
        email,
        name,
        passwordHash,
        emailVerified: null,
        workspaceName: (input.workspaceName && cleanLine(input.workspaceName)) || defaultWorkspaceName(name, email),
        requestId: deps.requestId,
    });
}

// ─── Google ─────────────────────────────────────────────────────────

export interface GoogleIdentity {
    providerAccountId: string;
    email: string | null | undefined;
    /** Google's `email_verified`. Only `true` counts. */
    emailVerified: unknown;
    name?: string | null;
    image?: string | null;
}

export type GoogleSignInOutcome = 'existing' | 'linked' | 'claimed' | 'created';

/**
 * Resolve a Google sign-in to an account, creating one (with its workspace)
 * when none exists. Refused unless Google vouches for the address
 * (`email_verified === true`): an unverified address is somebody else's until
 * proved, and linking on it would hand that somebody's account to whoever
 * typed it at Google.
 *
 * An existing account with a PROVED address is linked. One whose address
 * nobody proved (a password sign-up) is CLAIMED: Google has now proved the
 * address belongs to this person, so the password somebody else may have set
 * is removed and every session is signed out (`sessionVersion` bump).
 */
export async function resolveGoogleSignIn(identity: GoogleIdentity, requestId?: string): Promise<{ userId: string; outcome: GoogleSignInOutcome }> {
    if (identity.emailVerified !== true || !identity.email) {
        throw new ForbiddenError('Google did not verify this email address.');
    }
    const email = normaliseEmail(identity.email);

    const linked = await runWithoutRls({ reason: 'auth-identity' }, (db) =>
        UserRepository.findByAccount(db, 'google', identity.providerAccountId),
    );
    if (linked) return { userId: linked.userId, outcome: 'existing' };

    const existing = await runWithoutRls({ reason: 'auth-identity' }, (db) => UserRepository.findByEmail(db, email));
    if (existing) {
        const claim = existing.emailVerified === null && existing.passwordHash !== null;
        await runWithoutRls({ reason: 'auth-identity' }, (db) =>
            db.$transaction(async (tx) => {
                await UserRepository.linkAccount(tx, {
                    userId: existing.id,
                    provider: 'google',
                    providerAccountId: identity.providerAccountId,
                    type: 'oauth',
                });
                if (claim) {
                    await UserRepository.claimUnverified(tx, existing.id);
                    await UserRepository.revokeAllSessions(tx, existing.id, 'account-claimed');
                } else if (existing.emailVerified === null) {
                    await UserRepository.markVerified(tx, existing.id);
                }
            }),
        );
        await recordUserAuthEvent({
            userId: existing.id,
            action: claim ? 'ACCOUNT_CLAIMED' : 'ACCOUNT_LINKED',
            details: { provider: 'google' },
            requestId,
        });
        return { userId: existing.id, outcome: claim ? 'claimed' : 'linked' };
    }

    const name = (identity.name && cleanLine(identity.name)) || null;
    const created = await provisionAccountWithWorkspace({
        email,
        name,
        passwordHash: null,
        emailVerified: new Date(),
        image: identity.image ?? null,
        workspaceName: defaultWorkspaceName(name, email),
        google: { providerAccountId: identity.providerAccountId },
        requestId,
    });
    return { userId: created.userId, outcome: 'created' };
}
