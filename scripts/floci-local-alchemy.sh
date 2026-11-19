#!/bin/sh
# Starts or stops the Floci of `local-alchemy` (compose.local-alchemy.yaml).
# Usage: sh scripts/floci-local-alchemy.sh <up | down>
# `up` waits until the Floci is healthy, so that `infra:deploy:floci` can follow it at once.
# `down` first removes the containers of the project: the Floci and the Lambda containers that the Floci made outside
# Compose. A Lambda container that stays keeps the network of the project, and `compose down` cannot remove it.
set -eu

cd "$(dirname "$0")/.."
compose='docker compose -f compose.local-alchemy.yaml'
# The project name of compose.local-alchemy.yaml, and the prefix of its Lambda containers.
project=leads-local-alchemy
# The `flociPort` of `local-alchemy` in deployments.ts.
endpoint="${FLOCI_ENDPOINT:-http://127.0.0.1:4568}"

case "${1:-}" in
  up)
    $compose up -d
    attempt=0
    until curl --fail --silent --output /dev/null "$endpoint/_floci/health"; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 30 ]; then echo "The Floci of local-alchemy did not become ready at $endpoint" >&2; exit 1; fi
      sleep 1
    done
    ;;
  down)
    containers=$(docker ps -aq --filter "name=^${project}-")
    if [ -n "$containers" ]; then docker rm -f $containers >/dev/null; fi
    $compose down
    ;;
  *) echo 'Usage: sh scripts/floci-local-alchemy.sh <up | down>' >&2; exit 1 ;;
esac
