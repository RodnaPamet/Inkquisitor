# Backup and restore (the drill)

Phase 5.H-a (decision D36; roadmap 5.H item 6). Inkquisitor is backed up at the DATABASE level: one PostgreSQL
database holds every workspace, its encrypted author text, its vectors (pgvector), its row-level security and its
hash-chained audit trail. A backup is a `pg_dump` of that database; a restore is a `pg_restore` of it into a fresh
database (or a fresh instance). This page is the procedure, and `tests/integration/backup-restore-drill.test.ts` runs
it on every CI build and proves a workspace comes back intact.

## What a backup must keep, and what it needs beside it

- **The database dump.** `pg_dump --format=custom` (compressed, restorable selectively, ordered by `pg_restore`). It
  holds every table, sequence, function, trigger, policy, grant and the `vector` extension's objects.
- **The roles.** The dump names roles but does not create them. Row-level security depends on `app_user` (the role
  every request runs as) existing in the target cluster with no login and the grants the migrations gave it. Dump them
  with `pg_dumpall --roles-only` (the file holds password hashes: store it with the same care as the dump) or recreate
  them from the first migration (`prisma/migrations/20261118202649_identity_workspace_rls`).
- **`DATA_ENCRYPTION_KEY`.** Author text is sealed under each workspace's data key, which is stored WRAPPED under this
  master key (`Workspace.encryptedDek`). A dump without the master key is ciphertext nobody can read; the master key
  is never in the database and never in the dump. Keep it in the secrets store, apart from the backups, and restore
  with the same value (`DATA_ENCRYPTION_KEY_PREVIOUS` too, mid-rotation).
- **Stored objects** (`FILE_STORAGE_ROOT` or the S3 bucket, under `workspaces/<id>/`). Nothing is stored there today
  (sources, imports and exports never keep the file); when something is, back the bucket up with the same schedule.
- **Not needed:** Redis (the queue and the rate-limit counters are rebuilt; a queued job lost is retried by its
  schedule), the application image (rebuilt from the repository).

## Taking a backup

```bash
# The same major version as the server (16): run the tools from the Postgres image when the host's differ.
pg_dump --format=custom --no-password --dbname="$DIRECT_DATABASE_URL_WITHOUT_SCHEMA" --file=inkquisitor-$(date -u +%F).dump
pg_dumpall --roles-only --no-password --dbname="$SUPERUSER_URL" --file=inkquisitor-roles-$(date -u +%F).sql
```

Use the DIRECT connection (not PgBouncer: `pg_dump` needs a session) and drop Prisma's `?schema=public` parameter,
which libpq refuses. Run as the database owner or a superuser.

## Restoring

```bash
createdb --template=template0 inkquisitor_restored      # a fresh, empty database
psql -f inkquisitor-roles-YYYY-MM-DD.sql                # a fresh instance only: the roles first
pg_restore --exit-on-error --no-password --dbname=postgresql://…/inkquisitor_restored inkquisitor-YYYY-MM-DD.dump
```

`CREATE EXTENSION vector` needs a superuser (as the migration does); the image's `POSTGRES_USER` is one. Then point
`DATABASE_URL` / `DIRECT_DATABASE_URL` at the restored database, keep `DATA_ENCRYPTION_KEY` as it was, and start the
web tier and the worker: the boot-time encrypt → decrypt sentinel and `prisma migrate status` must both pass.

## Proving it (what the drill checks)

The integration test makes a workspace with encrypted bible fields, a scene with versions, an audit trail and vectors,
dumps the integration database, restores it into a fresh database, and reads the copy back through the product's own
client (`createDatabase`: the encryption extension and row-level security):

| Check | How |
| --- | --- |
| Every row came back | each workspace-scoped table (from the Prisma schema) holds the same number of the workspace's rows |
| Encrypted text is the same and readable | the same `v2:` ciphertexts, which decrypt to the original text with the workspace's data key, unwrapped from the restored row under the same `DATA_ENCRYPTION_KEY` |
| The audit chain holds | `verifyAuditChain` recomputes every hash and finds the same chain, unbroken |
| Row-level security holds | every policy (`pg_policies`) and every FORCE RLS table is there, and another workspace's context reads none of the workspace's rows |
| The append-only triggers hold | a DELETE of an audit row or a scene version is still refused |
| Vectors are the same | every embedding equal, and a nearest-neighbour search answers the same |

**The tools.** `pg_dump` and `pg_restore` must be the server's major version. CI's Test job sets
`PG_TOOLS_CONTAINER=ci-postgres`, so the drill runs them inside the Postgres container the job started (exactly the
image's); locally they are taken from `PATH` and their version is checked. Missing tools fail the test, with the
reason: an integration test never skips.

## A drill by hand

Once a quarter, and after any change to the image, the schema's extensions or the key handling: restore the newest
production backup into a scratch database on a separate host, start the application against it with production's
`DATA_ENCRYPTION_KEY`, sign in as a test OWNER, open a book and a scene (the text decrypts), and run
`verifyAuditChain` for one workspace. Record the date, the backup's age and the time the restore took.
