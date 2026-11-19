#!/bin/bash
# Docker entrypoint init script for Postgres.
# Creates the app_user role that the row-level-security policies of
# Phase 0.3 are written against. Runs automatically on the first start
# of the container (fresh volume) from docker-compose.yml.
#
# It runs as POSTGRES_USER, the image's superuser, and so does `prisma
# migrate` in the dev stack and in CI: the 2.0 migration's `CREATE EXTENSION
# vector` needs a superuser (pgvector is not a trusted extension). Where
# migrations run as another role, a superuser creates the extension once
# first; see the header of prisma/migrations/*_vector_store/migration.sql.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user NOLOGIN;
        RAISE NOTICE 'Created role app_user';
      END IF;
      -- An RLS migration may end with \`GRANT app_user TO postgres\`. Where
      -- POSTGRES_USER is not \`postgres\` (a test stack) that grant would fail
      -- with "role postgres does not exist", so a placeholder NOLOGIN role is
      -- created. NOLOGIN means no authentication attaches to it.
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
        CREATE ROLE postgres NOLOGIN;
        RAISE NOTICE 'Created placeholder role postgres for migration compat';
      END IF;
    END
    \$\$;

    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
    GRANT app_user TO $POSTGRES_USER;
EOSQL
