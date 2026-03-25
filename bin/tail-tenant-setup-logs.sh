#!/usr/bin/env bash
set -euo pipefail

# Tail CloudWatch logs from the Aurora tenant setup SQS handler Lambda.
#
# Usage: bin/tail-tenant-setup-logs.sh [aws-logs-tail-options...]
# Example: bin/tail-tenant-setup-logs.sh --since 1h --follow

STAGE=$(cat .sst/stage 2>/dev/null) || {
  echo "Error: could not read stage from .sst/stage" >&2
  exit 1
}

LOG_GROUP="/aws/lambda/filone-${STAGE}-AuroraTenantSetup"

echo "Log group: $LOG_GROUP" >&2
exec aws logs tail "$LOG_GROUP" "$@"
