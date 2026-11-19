#!/bin/sh
set -eu

trap 'docker compose -f compose.integration.yaml down' EXIT
docker compose -f compose.integration.yaml up -d

attempt=0
until curl --fail --silent --output /dev/null "http://127.0.0.1:${FLOCI_PORT:-4566}/_floci/health"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Floci did not become ready' >&2
    exit 1
  fi
  sleep 1
done

FLOCI_ENDPOINT="http://127.0.0.1:${FLOCI_PORT:-4566}" ./node_modules/.bin/turbo run test:integration
