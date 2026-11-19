#!/bin/sh
# Starts a Floci of its own, deploys the e2e stack with one IaC tool, and runs the e2e suite against it.
# Usage: sh test-e2e-floci.sh <iac tool> [vitest arguments]. The tools: cdk, alchemy.
# Each tool has its own Floci image, port, and Compose project, so the two tools can run at the same time.
# Turborepo builds the e2e bundle of @leads/lambda (`build:e2e`) before this script.
set -eu

iac="${1:?Give the IaC tool: cdk or alchemy}"
shift
cd "$(dirname "$0")"

case "$iac" in
  cdk) compose_file=compose.e2e.yaml port=4567 ;;
  # The Floci image of Alchemy: the image of the repo lacks an API that Alchemy calls (spec 0005).
  alchemy) compose_file=compose.e2e.alchemy.yaml port=4569 ;;
  *) echo "Unknown IaC tool: $iac" >&2; exit 1 ;;
esac

export FLOCI_E2E_PROJECT="leads-e2e-$iac-$$"
export FLOCI_E2E_PORT="${FLOCI_E2E_PORT:-$port}"
export FLOCI_ENDPOINT="http://127.0.0.1:$FLOCI_E2E_PORT"
# The handlers run in containers on the Compose network, where the Floci service is `floci`.
export FLOCI_LAMBDA_ENDPOINT="http://floci:4566"
# The harness reads the prefix of this deployment (deployments.ts), unless LEADS_BUCKET_PREFIX is set.
export DEPLOYMENT="e2e-$iac"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
cleanup() {
  docker compose -p "$FLOCI_E2E_PROJECT" -f "$compose_file" down --remove-orphans
  # Lambda containers are created by Floci, outside Compose's service set.
  containers=$(docker ps -aq --filter "name=^${FLOCI_E2E_PROJECT}-")
  if [ -n "$containers" ]; then docker rm -f $containers >/dev/null; fi
}
trap cleanup EXIT INT TERM

docker compose -p "$FLOCI_E2E_PROJECT" -f "$compose_file" up -d
attempt=0
until curl --fail --silent --output /dev/null "$FLOCI_ENDPOINT/_floci/health"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then echo 'E2E Floci did not become ready' >&2; exit 1; fi
  sleep 1
done

case "$iac" in
  cdk) LEADS_CDK_APP=./e2e/app pnpm --filter @leads/cdk exec tsx src/deploy-floci.ts ;;
  # The e2e app keeps its state in memory: the state of a run ends with the Floci of the run.
  alchemy) pnpm --filter @leads/alchemy exec alchemy deploy src/e2e/alchemy.run.ts --stage e2e-alchemy --yes --no-input ;;
esac

VITEST_E2E=1 pnpm exec vitest run --reporter=verbose "$@"
