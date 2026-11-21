-- Phase 3.H: hardening the story canvas (issue #45, items 1 and 5).
--
-- ═══════════════════════════════════════════════════════════════════
-- A snapshot names the map's CURRENT version (issue #45, item 1)
-- ═══════════════════════════════════════════════════════════════════
--
-- Every path that writes a snapshot moves the map's version first and then
-- writes the snapshot of that version, in the same transaction: a save
-- (`StoryMapRepository.commit`, then `MapSnapshotRepository.create`), a map's
-- first save (created at 1, then its snapshot), a restore, and a bible
-- deletion (its cascade's trigger bumps the version, then
-- `recordMapsAfterBibleDeletion` writes it). The unique (mapId, version)
-- refused a second snapshot of a version, but nothing refused one AHEAD of the
-- map: app_user could insert a snapshot for version N + 1, and the map's next
-- save, writing N + 1 itself, then hit the unique key — a 500 for every save
-- of that map, for ever. So an insert must name exactly the version the map
-- holds now, for every role (no product path writes any other).
--
-- The map is read FOR SHARE: a save moving it holds its row (the conditional
-- bump), so an insert racing a save waits for it and then compares with the
-- committed version. A map this role cannot see (another workspace's, under
-- row-level security) or that does not exist is left to what already refuses
-- it — the row-level policy's WITH CHECK and the composite foreign key — so
-- the isolation tests still see row-level security's own refusal.

CREATE OR REPLACE FUNCTION map_snapshot_names_current_version() RETURNS trigger
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    current_version INTEGER;
BEGIN
    SELECT "version" INTO current_version FROM "StoryMap" WHERE "id" = NEW."mapId" FOR SHARE;
    IF current_version IS NULL THEN
        RETURN NEW;
    END IF;
    IF current_version <> NEW."version" THEN
        RAISE EXCEPTION 'MAP_SNAPSHOT_NOT_CURRENT: a snapshot of version % for a map at version %', NEW."version", current_version
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS map_snapshot_names_current_version ON "MapSnapshot";
CREATE TRIGGER map_snapshot_names_current_version
    BEFORE INSERT ON "MapSnapshot"
    FOR EACH ROW EXECUTE FUNCTION map_snapshot_names_current_version();

-- ═══════════════════════════════════════════════════════════════════
-- One setting for the cascade marker, not one per map (issue #45, item 5)
-- ═══════════════════════════════════════════════════════════════════
--
-- A bible deletion moves each map it touches once per transaction (the 3.1
-- migration's header). The marker was a transaction-local setting NAMED after
-- the map (`inkquisitor.map_cascade_<md5>`): the value resets at the end of
-- the transaction, but PostgreSQL keeps every custom setting's NAME as a
-- placeholder for the life of the backend, so a pooled connection gathered
-- one more per distinct map it ever cascaded. One setting now holds the
-- transaction's id and the maps it moved (`<txid>:,<id>,<id>,`); a value left
-- by another transaction (a savepoint's, released) reads as empty.
-- Map ids are cuids: no comma can occur in one.

CREATE OR REPLACE FUNCTION map_bump_once_for_cascade(map_id TEXT) RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    prefix TEXT := txid_current()::text || ':';
    seen TEXT := coalesce(current_setting('inkquisitor.map_cascade', true), '');
BEGIN
    IF left(seen, length(prefix)) IS DISTINCT FROM prefix THEN
        seen := prefix || ',';
    END IF;
    IF strpos(seen, ',' || map_id || ',') = 0 THEN
        UPDATE "StoryMap" SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = map_id;
        -- A map going with its book or workspace finds no row: it is not
        -- remembered, so a purge of many maps never grows the setting.
        IF FOUND THEN
            PERFORM set_config('inkquisitor.map_cascade', seen || map_id || ',', true);
        END IF;
    END IF;
END;
$$;
