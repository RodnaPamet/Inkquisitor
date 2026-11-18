# Prisma schema folder

Prisma reads every `.prisma` file in this folder (named in `prisma.config.ts`)
and concatenates them at generate and migrate time.

| File | Holds |
|---|---|
| `base.prisma` | The `generator` and `datasource` blocks — and nothing else. Prisma rejects a duplicate of either anywhere in the folder. |

The skeleton has no models yet. Phase 0.3 adds `auth.prisma` (users,
workspaces, memberships, sessions); Phase 1.1 adds `bible.prisma`. Pick the
file that matches a new model's domain, keep files to about thirty models, and
put shared enums in an `enums.prisma` once the first one exists.
