#!/bin/bash
#
# Check whether an SST stage exists by attempting to export its state.
#
# Distinguishes "stage genuinely not deployed" from other failures
# (expired credentials, AccessDenied, throttling, backend outages) so callers
# don't silently skip teardown on transient errors.
#
# Usage:
#   bin/check-sst-stage-exists.sh <stage>
#
# Output:
#   On stdout: "true"  if the stage exists
#              "false" if the stage is definitively not deployed
#   On stderr: full error text when the result is ambiguous
#
# Exit codes:
#   0  result printed (true|false)
#   1  ambiguous failure — caller should treat as a hard error, not "not found"
#   2  usage error

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,"");print}' "$0"
  exit 0
fi

STAGE="${1:?Usage: check-sst-stage-exists.sh <stage>}"

stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

pnpm exec sst state export --stage "$STAGE" >/dev/null 2>"$stderr_file"
exit_code=$?
stderr_output=$(cat "$stderr_file")

if [ "$exit_code" -eq 0 ]; then
  echo "true"
  exit 0
fi

# Disqualifying signals — if any appear, the failure is NOT a clean
# "stage doesn't exist"; surface it and exit non-zero.
aws_error_pattern='AccessDenied|UnauthorizedOperation|InvalidClientTokenId|ExpiredToken|credentials|Throttl|RequestTimeout|InternalError|ServiceUnavailable|SignatureDoesNotMatch'
if echo "$stderr_output" | grep -qiE "$aws_error_pattern"; then
  echo "sst state export failed with an AWS error (not a missing-stage condition):" >&2
  echo "$stderr_output" >&2
  exit 1
fi

if echo "$stderr_output" | grep -q "Could not pull state"; then
  echo "false"
  exit 0
fi

echo "sst state export failed with an unrecognised error (treating as failure to avoid silently skipping teardown):" >&2
echo "$stderr_output" >&2
exit 1
