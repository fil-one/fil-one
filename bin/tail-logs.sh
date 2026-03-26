#!/usr/bin/env bash
set -euo pipefail

# Tail CloudWatch logs from any Hyperspace Lambda handler.
# Lists all API route handlers (and other Lambda handlers) from SST state,
# lets you pick one, then tails the logs.
#
# Usage: bin/tail-logs.sh [--stage <stage>] [aws-logs-tail-options...]
# Example: bin/tail-logs.sh
# Example: bin/tail-logs.sh --stage staging --since 1h
#
# The --stage flag defaults to $USER.
# When no extra aws-logs-tail options are given, defaults to --follow.

STAGE="$USER"

# Parse --stage flag, pass everything else through to `aws logs tail`
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

# Default to --follow when no extra options are given
if [ ${#EXTRA_ARGS[@]} -eq 0 ]; then
  EXTRA_ARGS=(--follow)
fi

echo "Using stage: $STAGE" >&2

SST_STATE=$(sst state export --stage "$STAGE")

# Extract the AWS region from the default provider in SST state
REGION=$(echo "$SST_STATE" | jq -r '
  [.latest.resources[]
   | select(.type == "pulumi:providers:aws")
   | select(.urn | test("::default"))
   | .outputs.region
  ] | first // empty
')
if [ -z "$REGION" ]; then
  echo "Warning: could not detect region from SST state, using default" >&2
else
  echo "Region: $REGION" >&2
  export AWS_REGION="$REGION"
fi

# Build a list of "ROUTE_KEY\tLOG_GROUP" lines from SST state.
# For API routes, the route key is the HTTP verb + path (e.g. "POST /api/buckets").
# For non-API-route handlers, we use the resource name as the label.
HANDLERS=$(echo "$SST_STATE" | jq -r '
  # Map from route ID prefix -> routeKey
  (
    [.latest.resources[]
     | select(.type == "aws:apigatewayv2/route:Route")
     | { key: (.urn | capture("ApiRoute(?<id>[A-Za-z]+)Route$").id), value: .outputs.routeKey }
    ] | from_entries
  ) as $routes |

  # API route handlers
  (
    [.latest.resources[]
     | select(.type == "aws:cloudwatch/logGroup:LogGroup")
     | select(.urn | test("ApiRoute[A-Za-z]+Handler"))
     | .id = (.urn | capture("ApiRoute(?<id>[A-Za-z]+)Handler").id)
     | { label: ($routes[.id] // "unknown \(.id)"), logGroup: .outputs.name }
    ]
  ) +
  # Non-API-route Lambda handlers (SQS subscribers, setup functions, etc.)
  (
    [.latest.resources[]
     | select(.type == "aws:cloudwatch/logGroup:LogGroup")
     | select(.outputs.name | test("/aws/lambda/"))
     | select(.urn | test("ApiRoute") | not)
     | .label = (.urn | split("$") | last | split("::") | last | gsub("LogGroup$"; ""))
     | { label: .label, logGroup: .outputs.name }
    ]
  )
  | sort_by(.label)
  | .[]
  | "\(.label)\t\(.logGroup)"
')

if [ -z "$HANDLERS" ]; then
  echo "Error: no Lambda handlers found in SST state for stage '$STAGE'" >&2
  exit 1
fi

# Let the user pick a handler interactively with fzf
LABELS=$(echo "$HANDLERS" | cut -f1)
SELECTED=$(echo "$LABELS" | fzf --height=~20 --prompt="Select handler: " --no-multi) || exit 0

# Find the log group for the selected label
LOG_GROUP=$(echo "$HANDLERS" | grep -F "$SELECTED" | head -1 | cut -f2)

echo "" >&2
echo "Endpoint: $SELECTED" >&2
echo "Log group: $LOG_GROUP" >&2
echo "" >&2
echo "aws logs tail '$LOG_GROUP' ${EXTRA_ARGS[*]}" >&2
echo "" >&2
exec aws logs tail "$LOG_GROUP" "${EXTRA_ARGS[@]}"
