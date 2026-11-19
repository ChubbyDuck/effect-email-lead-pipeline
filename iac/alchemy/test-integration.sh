#!/bin/sh
# Starts the Floci of compose.integration.yaml on port 4570, runs the plan test against it, and stops it.
set -eu

compose='docker compose -f compose.integration.yaml'
trap "$compose down" EXIT
$compose up -d

attempt=0
until curl --fail --silent --output /dev/null 'http://127.0.0.1:4570/_floci/health'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'The Floci of Alchemy did not become ready' >&2
    exit 1
  fi
  sleep 1
done

FLOCI_ENDPOINT='http://127.0.0.1:4570' VITEST_INTEGRATION=1 vitest run
