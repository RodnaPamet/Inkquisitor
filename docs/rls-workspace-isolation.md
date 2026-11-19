# Workspace isolation (row-level security)

Every workspace's data is isolated twice: by PostgreSQL row-level security,
which the application cannot bypass by accident, and by a `workspaceId`
filter in every repository query (defence in depth, and a clear empty result
when the application is right). This page is the guide to the first layer.

## The model

| Piece | What it is |
|---|---|
| `app_user` | A `NOLOGIN` role. Every workspace transaction runs as it. |
| `runInWorkspaceContext(ctx, fn)` | `src/lib/db/rls-middleware.ts`. Opens a transaction, `SET LOCAL ROLE app_user`, `set_config('app.workspace_id', …, true)` and `app.request_id`. Transaction-scoped, so safe under PgBouncer's transaction pooling. |
| `workspace_isolation` | One policy per workspace-scoped table, `USING` and `WITH CHECK` on `"workspaceId" = current_setting('app.workspace_id', true)` (`Workspace` itself on `"id"`). A row is visible, insertable and updatable only in its own workspace's transaction. One policy, not a separate insert sibling: a second permissive policy is OR'd with the first and could open it. |
| `superuser_bypass` | `USING (current_setting('role') != 'app_user')`. Every connection that has not switched role — migrations, and the plain client in sign-in, sign-up and the membership gate — sees every row. |
| `FORCE ROW LEVEL SECURITY` | The table owner is bound by the policies too, so the bypass is the policy above and nothing implicit. A superuser skips RLS whatever FORCE says, which is why the context switches ROLE. |
| `runWithoutRls({ reason }, fn)` | The explicit, logged bypass, for code that runs before a workspace is known. The reason is a closed union (`RlsBypassReason`); adding one is a review decision. |
| `bindWorkspaceInTransaction(tx, ctx)` | Switches a transaction the caller already holds into a workspace. Only sign-up uses it: it creates the user and the workspace as the owning role, then writes the membership and the audit rows as `app_user`, in one transaction. |
| RLS tripwire | A Prisma extension that logs (never blocks) a query on a workspace-scoped model made outside both a context and the bypass. |

`app_user` holds no grant on `Account`, `UserSession` or `VerificationToken`:
those are read only on the plain client. On `User` it holds SELECT on `id`,
`name` and `email` only (what a member list shows) and no write: a password
hash or a session version is never readable from a workspace transaction. `AuditLog` is append-only for every
role (a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`; `app_user` has no
`UPDATE`/`DELETE` grant either).

The bible's tables (Phase 1.1: `Book`, `BibleElement`, `BibleField`,
`BibleRelation`, `BibleEntryVersion`) are workspace-scoped like the rest, and
carry the workspace in every foreign key: a child references its parent by
`(workspaceId, id)`, and a relation's two ends by `(bookId, id)`, so the
database refuses an element under another workspace's book and a relation
between two books, whoever writes. `BibleEntryVersion` is append-only like the
audit trail (`app_user` has no `UPDATE`, `DELETE` or `TRUNCATE`; a trigger
refuses them for every role), except the deletion its book's cascade makes and
the clearing of `authorId` when that person is deleted.

The vector store's table (subphase 2.0: `VectorEmbedding`) carries the same
set. Its book scope is the composite `(workspaceId, bookId)`, so a vector
cannot be filed under another workspace's book, and its seam
(`src/app-layer/repositories/vector.repository.ts`) adds one check of its
own: the pgvector backend refuses a transaction that is not `app_user` bound
to the workspace the call names (`NOT_IN_WORKSPACE_CONTEXT`), so it never
runs on the plain client, where the policies would not apply.

The question engine's tables (Phase 2.2: `InterviewSession`,
`InterviewRound`, `Question`, `Answer`) carry the same set and the workspace in
every foreign key: a session's book by `(workspaceId, bookId)`, a question's
session by `(workspaceId, bookId, sessionId)` and its element by
`(bookId, elementId)`, an answer's question by `(workspaceId, sessionId,
questionId)`. `Answer` is append-only like the version table (`app_user` has
no `UPDATE`, `DELETE` or `TRUNCATE`; a trigger refuses them for every role),
except the deletion its question's cascade makes and the clearing of
`answeredById` when that person is deleted. `Question` is the vector store's
first source table: its vectors are deleted with it, and the store refuses a
vector for a question that does not exist (`vector_embedding_require_source`).

With no workspace bound, `app_user` sees nothing: the policy compares with
`NULL` and fails closed.

## Adding a workspace-scoped model

1. Give the model a `workspaceId String` and an `@@index` that leads with it,
   in a domain file under `prisma/schema/`.
2. Create the migration with `npm run db:migrate`, then append to it, for the
   new table:
   ```sql
   ALTER TABLE "Chapter" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "Chapter" FORCE ROW LEVEL SECURITY;
   CREATE POLICY workspace_isolation ON "Chapter"
       USING ("workspaceId" = current_setting('app.workspace_id', true)::text)
       WITH CHECK ("workspaceId" = current_setting('app.workspace_id', true)::text);
   CREATE POLICY superuser_bypass ON "Chapter"
       USING (current_setting('role') != 'app_user');
   ```
3. Reach it only through `runInWorkspaceContext` from a usecase, and filter
   by `workspaceId` in the repository as well.

`tests/guards/rls-migration-coverage.test.ts` (no database) and
`tests/integration/rls-coverage.test.ts` (the live catalogue) both fail until
the table has all four statements, EXACTLY as above: the guard compares the
whole statements, and the live test compares `pg_policies` (qual, with_check,
permissive, roles, cmd) with PostgreSQL's normalised form, then proves, per
table, that `app_user` bound to one workspace sees its own rows, none of
another's, and cannot insert one of another's. A predicate that merely
mentions `app.workspace_id` (`!=`, `IS NOT NULL`) fails both; their negative
controls prove it. A model WITHOUT a `workspaceId` fails them
too unless it is listed, with a reason, in `GLOBAL_MODELS`
(`src/lib/db/rls-tripwire.ts`): a table cannot dodge isolation by leaving the
column out.

## Proof

`tests/integration/workspace-isolation.test.ts` drives two workspaces through
the app role: reading, updating and deleting the other's rows, inserting with
the other's `workspaceId`, and moving an own row into the other workspace are
all refused by the database, with queries that carry no `workspaceId` filter
of their own.

## Triggers that hold a rule RLS cannot

Row-level security decides which rows a role may touch, not what a workspace
must keep. One rule needs the database's own backstop, beside the usecase:

- **`workspace_membership_last_owner_guard`** (Phase 0.H) refuses, with
  SQLSTATE P0001, any UPDATE or DELETE on `WorkspaceMembership` that would
  leave a workspace with no OWNER, for every role. It takes the usecase's
  advisory lock key (`hashtext('workspace-owner:' || workspaceId)`) before it
  counts, so two concurrent demotions serialise; its function must stay
  VOLATILE, or the count reads a snapshot from before the lock. A workspace's
  own deletion cascades past it. Under `app_user` the count is complete: the
  caller can only touch memberships of the workspace its context names, and
  sees every other membership of that workspace.
  `tests/integration/last-owner-guard.test.ts` holds it.
