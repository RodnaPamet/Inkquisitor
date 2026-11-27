# The author's data: export, deletion, retention

Phase 5.H-a (decision D36; roadmap 5.H item 4; issue #71). What Inkquisitor gives an author of everything it holds,
how it deletes it, and the one thing it keeps.

## The full export

`POST /api/w/<slug>/export` (`workspace.export`, OWNER only; Settings → Your data → Export everything). One zip,
encrypted with WinZip AES-256 (AE-2) under a passphrase the author chooses at download. The layout and every file's
description are one table, `src/lib/export/archive-layout.ts`; the archive's own README is generated from it.

- **Per live book** (`books/<NN>-<slug>/`): its details; its bible as the Markdown bundle, byte for byte what the bible
  export writes (Import takes it back); its manuscript as DOCX and Markdown, with an outline JSON (titles, word counts,
  point of view, setting, story time, note, card, links); and every history and decision as JSON Lines: bible and
  relation versions, scene, note and card versions, map snapshots, interview sessions, rounds, questions and answers,
  enrichment and research proposals with their decisions, facts and fact proposals, threads and their scene links,
  research briefs, attached sources and findings, the book's source library with the kept text of each source, and its
  stress tests.
- **Workspace-wide:** its name and members (roles and names, never a collaborator's email), its series library, and
  its audit trail.
- **Not included** (and said in the README): books and scenes in Recently deleted (restore first; a deleted scene's
  versions are in its book's history anyway), embeddings (derived), prose-check notes and the nightly readings'
  bookkeeping (derived), model-call records (no text).
- **The author's uploaded sources** are included as the text chunks Inkquisitor keeps of them: they are the author's
  material, and the file itself is never stored.

THE PASSPHRASE travels in the request body only, is at least 12 characters, and is never stored, logged, traced,
audited or put in a job payload or URL (`tests/integration/privacy-sinks.test.ts`). AE-2 derives the key with
PBKDF2-SHA1 (1,000 iterations, the format's own), so the passphrase's length is what protects the archive.

IN THE REQUEST, STREAMED: a job would need the passphrase in its payload, or the archive stored unencrypted until it was
fetched. The archive is written as the response is read, one page and one manuscript in memory at a time.

## Deleting a scene (issue #71)

Soft for 30 days (the database's clock): the scene leaves every list and read and waits in its manuscript's Recently
deleted with its text, note, card, links, versions and research proposals; a restore puts it back at its place, or at
the end of its chapter when that place is taken. After 30 days the daily `scene-purge` job deletes it with its
history and proposals. The database refuses an earlier hard delete (`manuscript_scene_delete_only_when_purge_due`); a
deleted chapter takes its recently deleted scenes with it, and its confirmation counts them.

## Deleting the workspace (D36)

An OWNER names the workspace exactly (Settings → Your data → Delete workspace), optionally asking for their account to
go too (only when it is their only workspace). It closes at once for every member and every background job, and its
queued jobs are removed. One of its OWNERs may restore it within 30 days from the page a signed-in person with no
workspace lands on. Then the daily `workspace-purge` job deletes, in this order: every object under
`workspaces/<id>/` in storage, every queued or retained job naming it, and the workspace row, whose cascade takes every
workspace-scoped row — books, bibles and every version, interviews, sources and facts, vectors, the manuscript and its
versions, model-call records, memberships and settings — and, when asked, the requester's account if they belong to
no other workspace by then. Every deletion therefore completes within 31 days of the request.
`tests/integration/workspace-deletion.test.ts` counts zero rows of the workspace in every workspace-scoped table,
enumerated from the Prisma schema.

## What is kept: the audit trail

The workspace's hash-chained audit trail (`AuditLog`) is the one exception. It has no foreign key by design, is
append-only for every role, and holds ids, counts and codes — never author text, a passphrase or an email
(CLAUDE.md, "Audit trail"). It is kept so the deletion itself is on record: the purge appends `WORKSPACE_PURGED` (with
counts, and whether the account was deleted) to the workspace's own chain, which still verifies. It names users by id
only; a deleted account's id names nobody.
