#!/usr/bin/env bash
set -euo pipefail

# Tail CloudWatch logs from the Aurora tenant setup SQS handler Lambda.
# The SQS handler Lambda doesn't follow the filone-<stage>- naming
# convention, making it hard to find the CloudWatch log group manually.
# This script extracts the log group name from SST state and passes through
# any additional arguments to `aws logs tail`.
#
# Usage: bin/tail-tenant-setup-logs.sh [aws-logs-tail-options...]
# Example: bin/tail-tenant-setup-logs.sh --since 1h --follow

LOG_GROUP=$(
  sst state export \
    | jq -r '
        .latest.resources[]
        | select(.type == "aws:cloudwatch/logGroup:LogGroup")
        | select(.urn | contains("AuroraTenantSetupQueue"))
        | .outputs.name
      '
)

if [ -z "$LOG_GROUP" ]; then
  echo "Error: could not find AuroraTenantSetupQueue log group in SST state" >&2
  exit 1
fi

echo "Log group: $LOG_GROUP" >&2
exec aws logs tail "$LOG_GROUP" "$@"
