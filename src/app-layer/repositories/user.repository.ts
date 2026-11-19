/**
 * Users. `User` is not workspace-scoped (a person exists before and across
 * workspaces), so these take whichever client the caller holds: the plain
 * client in sign-in and sign-up, a workspace transaction when a member list
 * names its members.
 */
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

export const UserRepository = {
    findByEmail(db: Db, email: string) {
        return db.user.findUnique({
            where: { email },
            select: { id: true, email: true, name: true, passwordHash: true, emailVerified: true },
        });
    },

    findIdentity(db: Db, id: string) {
        return db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, image: true } });
    },

    create(db: Db, data: { email: string; name: string | null; passwordHash: string | null; emailVerified: Date | null; image?: string | null }) {
        return db.user.create({ data, select: { id: true, email: true } });
    },

    findByAccount(db: Db, provider: string, providerAccountId: string) {
        return db.account.findUnique({
            where: { provider_providerAccountId: { provider, providerAccountId } },
            select: { userId: true },
        });
    },

    linkAccount(db: Db, data: { userId: string; provider: string; providerAccountId: string; type: string }) {
        return db.account.create({ data, select: { id: true } });
    },

    /**
     * A provider that vouches for the address takes over an account whose
     * address nobody proved: the password goes, every session is signed out
     * (`sessionVersion`), and the address is marked verified.
     */
    claimUnverified(db: Db, userId: string) {
        return db.user.update({
            where: { id: userId },
            data: { passwordHash: null, emailVerified: new Date(), sessionVersion: { increment: 1 } },
            select: { id: true },
        });
    },

    /** Sign out every session of `userId` (the claim path: the old sessions may be someone else's). */
    revokeAllSessions(db: Db, userId: string, reason: string) {
        return db.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    },

    markVerified(db: Db, userId: string) {
        return db.user.update({ where: { id: userId }, data: { emailVerified: new Date() }, select: { id: true } });
    },
};
