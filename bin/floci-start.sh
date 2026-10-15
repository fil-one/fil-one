#!/usr/bin/env bash
set -euo pipefail

# Start floci (https://github.com/floci-io/floci) for `pnpm deploy:local`.
#
# Usage: pnpm floci:start               (state persists in ~/.floci/data)
#        FLOCI_DATA=<dir> pnpm floci:start
#        FLOCI_DATA= pnpm floci:start   (in memory, as CI runs it)
#
# Lambda containers get an /etc/hosts entry pointing ingot.localhost at the
# host, so they reach a smelt Ingot under the same name browsers use.

FLOCI_IMAGE="${FLOCI_IMAGE:-floci/floci:2.1.0}"
FLOCI_DATA="${FLOCI_DATA-$HOME/.floci/data}"

if docker container inspect floci >/dev/null 2>&1; then
  echo "A floci container already exists. Remove it with \`docker rm -f floci\` and rerun." >&2
  exit 1
fi

args=(-d --name floci -p 4566:4566
  -v /var/run/docker.sock:/var/run/docker.sock
  -e FLOCI_SERVICES_LAMBDA_EXTRA_HOSTS=ingot.localhost:host-gateway)
if [ -n "$FLOCI_DATA" ]; then
  mkdir -p "$FLOCI_DATA"
  args+=(-v "$FLOCI_DATA:/app/data" -e FLOCI_STORAGE_MODE=persistent)
fi
docker run "${args[@]}" "$FLOCI_IMAGE" >/dev/null

for _ in $(seq 60); do
  [ "$(docker inspect floci --format '{{.State.Health.Status}}')" = healthy ] && exit 0
  sleep 2
done
echo "floci did not become healthy; see \`docker logs floci\`" >&2
exit 1
