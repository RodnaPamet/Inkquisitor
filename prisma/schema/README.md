# Prisma schema folder

Prisma reads every `.prisma` file in this folder (named in `prisma.config.ts`)
and concatenates them at generate and migrate time.

| File | Holds |
|---|---|
| `base.prisma` | The `generator` and `datasource` blocks — and nothing else. Prisma rejects a duplicate of either anywhere in the folder. |
| `enums.prisma` | Every shared enum (`WorkspaceRole`). |
| `auth.prisma` | People and how they sign in: `User`, `Account`, `VerificationToken`, `UserSession`. Not workspace-scoped. |
| `workspace.prisma` | `Workspace` (with its wrapped data key) and `WorkspaceMembership`. Workspace-scoped. |
| `audit.prisma` | `AuditLog`, the append-only, hash-chained trail. Workspace-scoped. |

Phase 1.1 adds `bible.prisma`. Pick the file that matches a new model's
domain and keep files to about thirty models. A model with a `workspaceId` is
workspace-scoped and needs its row-level security in the same migration
(`docs/rls-workspace-isolation.md`); a model without one must be listed in
`GLOBAL_MODELS` (`src/lib/db/rls-tripwire.ts`). Both coverage tests enforce
it.
