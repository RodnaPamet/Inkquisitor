#!/usr/bin/env bash
#
# Start an inkquisitor-postgres image for CI's Test and E2E jobs.
#
#   deploy/postgres/start.sh <image-ref> <database>
#
# The jobs build deploy/postgres/Dockerfile in the job (the image is not
# pulled from a registry: CI must pass before the first publish, and a pull
# request must test the Dockerfile it changes) and run it here, in place of a
# `postgres:16` service container, which carries no pgvector. It publishes
# 5432 on 127.0.0.1 only, with the well-known throwaway credentials the jobs'
# DATABASE_URL names (postgres/postgres: the image's superuser, which
# `prisma migrate deploy` needs for `CREATE EXTENSION vector`), waits until
# the server answers over TCP twice in a row, and refuses unless the vector
# extension is available to create.
#
# OVER TCP, NOT THE SOCKET. The upstream entrypoint runs initdb's work on a
# TEMPORARY server that listens on the Unix socket only
# (`listen_addresses=''`), then stops it and starts the real one. A
# `pg_isready` over the socket answers "ready" from the temporary server, so
# a probe that way can pass, run its checks and hand the job a server that is
# about to go away. The real server is the first to listen on 127.0.0.1.
set -euo pipefail

IMAGE="${1:?usage: start.sh <image-ref> <database>}"
DATABASE="${2:?usage: start.sh <image-ref> <database>}"
NAME="ci-postgres"

docker run -d --name "$NAME" \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DATABASE" \
    -p 127.0.0.1:5432:5432 \
    "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d "$DATABASE" -q 2>/dev/null \
        && sleep 1 \
        && docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d "$DATABASE" -q 2>/dev/null; then
        available=$(docker exec "$NAME" psql -U postgres -d "$DATABASE" -qAt \
            -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'")
        if [ "$available" != "1" ]; then
            echo "::error::$IMAGE does not offer the vector extension"
            exit 1
        fi
        echo "inkquisitor-postgres is up: database=$DATABASE, vector available"
        exit 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
        break
    fi
    sleep 1
done

echo "::error::postgres did not become ready"
docker logs "$NAME" 2>&1 | tail -20
exit 1
