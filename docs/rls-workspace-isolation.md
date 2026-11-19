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
those are read only on the plain client. `AuditLog` is append-only for every
role (a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`; `app_user` has no
`UPDATE`/`DELETE` grant either).

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
the table has all four statements. A model WITHOUT a `workspaceId` fails them
too unless it is listed, with a reason, in `GLOBAL_MODELS`
(`src/lib/db/rls-tripwire.ts`): a table cannot dodge isolation by leaving the
column out.

## Proof

`tests/integration/workspace-isolation.test.ts` drives two workspaces through
the app role: reading, updating and deleting the other's rows, inserting with
the other's `workspaceId`, and moving an own row into the other workspace are
all refused by the database, with queries that carry no `workspaceId` filter
of their own.
