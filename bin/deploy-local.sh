#!/usr/bin/env bash
set -euo pipefail

# Deploy the app to a local floci emulator (https://github.com/floci-io/floci).
#
# Usage: pnpm deploy:local            (stage defaults to "local")
#        STAGE=mine pnpm deploy:local
#
# Requires `floci start`. Unset secrets get a placeholder; set the real ones with
#   eval "$(floci env)" && LOCAL=true pnpm exec sst secret set <Name> --stage local
# Login needs Auth0ClientId/Secret for the shared dev tenant, with
# https://localhost:5173 registered there (docs/Auth0OneTimeSetup.md). Billing needs
# a sandbox StripeSecretKey/StripePublishableKey/StripePriceId and the Stripe CLI.
# SMELT=true runs the Forge dev region (us-east-9) against a local smelt network
# instead of the hosted one; SMELT_HOST overrides the host.docker.internal default.

cd "$(dirname "$0")/.."
STAGE="${STAGE:-local}"

missing=()
tools=(floci pnpm node aws)
[ "${SMELT:-}" = true ] && tools+=(docker)
for bin in "${tools[@]}"; do
  command -v "$bin" >/dev/null || missing+=("$bin")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required tools: ${missing[*]}" >&2
  exit 1
fi

eval "$(floci env)"
if command -v docker >/dev/null &&
  [ "$(docker inspect floci --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    sed -n 's/^FLOCI_STORAGE_MODE=//p')" != persistent ]; then
  echo "warning: floci keeps state in memory; restart it with \`floci start --persist ~/.floci/data\`" >&2
fi
unset AWS_PROFILE
export LOCAL=true

sst() { pnpm exec sst "$@" --stage "$STAGE"; }

# Only names are read here, never values.
set_secrets=$(sst secret list 2>/dev/null | grep -v '^#' | cut -d= -f1 || true)
placeholders=$(mktemp)
trap 'rm -f "$placeholders"' EXIT
for name in $(grep -oE "new sst\.Secret\('[A-Za-z0-9]+'" sst.config.ts | sed -E "s/.*'(.*)'/\1/" | sort -u); do
  grep -qx "$name" <<<"$set_secrets" || echo "$name=placeholder" >>"$placeholders"
done
if [ -s "$placeholders" ]; then
  echo "Setting placeholder secrets: $(cut -d= -f1 "$placeholders" | paste -sd' ' -)"
  sst secret load "$placeholders"
fi

# With smelt, its Hilt partner key replaces the hosted network's token. Going back
# to the hosted network means setting ForgeDevManagementApiToken again.
if [ "${SMELT:-}" = true ]; then
  smelt_key=$(docker inspect smelt-hilt-1 --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    sed -n 's/^HILT_AUTH_PARTNER_KEY=//p' | cut -d, -f1 || true)
  if [ -z "$smelt_key" ]; then
    echo "SMELT=true but smelt's hilt container is not running" >&2
    exit 1
  fi
  sst secret set ForgeDevManagementApiToken "$smelt_key" >/dev/null
fi

pnpm run build
sst deploy

api_url=$(node -p "require('./.sst/outputs.json').apiUrl" |
  sed -E 's#^https://([a-z0-9]+)\.execute-api\.[^/]+#http://\1.execute-api.localhost.floci.io:4566#')

# The events SetupStack would subscribe a deployed stage to.
events=$(sed -n '/^const WEBHOOK_EVENTS/,/];/p' packages/backend/src/jobs/stack-setup/setup-integrations.ts |
  grep -oE "'[a-z_.]+'" | tr -d "'" | paste -sd, -)

if command -v stripe >/dev/null && whsec=$(stripe listen --print-secret 2>/dev/null); then
  aws ssm put-parameter --overwrite --type SecureString \
    --name "/filone/$STAGE/stripe-webhook-secret" --value "$whsec" >/dev/null
  stripe_msg="Forward Stripe webhooks (keep running):
  stripe listen --events $events --forward-to $api_url/api/stripe/webhook"
else
  stripe_msg="Stripe CLI missing or not logged in: webhooks are off. Install it, run \`stripe login\`, and rerun."
fi

cat <<EOF

Deployed stage "$STAGE" to floci.

API: $api_url

Run the console against it at https://localhost:5173:
  echo "DEV_PROXY_TARGET=$api_url" >> packages/website/.env.local
  pnpm --filter @filone/website dev

$stripe_msg
EOF
