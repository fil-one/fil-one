#!/bin/bash
#
# Delete old Lambda versions for all versioned (provisioned concurrency) functions
# in a given SST stage, keeping only the N most recent versions.
#
# Every sst deploy to a PC-enabled stage publishes a new Lambda version. AWS
# counts all versions across all functions against a 75 GB account-level
# deployment package storage limit. Run this after deploys to keep the account
# clean.
#
# Usage:
#   bin/prune-lambda-versions.sh <stage> [keep]
#
# Arguments:
#   stage  The SST stage name (required)
#   keep   Number of most-recent versions to retain (default: 3)
#
# Environment variables:
#   REGION  AWS region to query (default: us-east-2)
#
# Examples:
#   bin/prune-lambda-versions.sh staging
#   bin/prune-lambda-versions.sh pr-42 5

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,"");print}' "$0"
  exit 0
fi

STAGE="${1:?Usage: prune-lambda-versions.sh <stage> [keep]}"
KEEP="${2:-3}"
REGION="${REGION:-us-east-2}"

echo "Stage:  $STAGE"
echo "Region: $REGION"
echo "Keep:   $KEEP most-recent versions per function"
echo ""

# Find all Lambda functions tagged with this SST stage
functions=$(aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=sst:stage,Values="$STAGE" \
  --resource-type-filters lambda:function \
  --query 'ResourceTagMappingList[].ResourceARN' \
  --output text --region "$REGION")

if [ -z "$functions" ]; then
  echo "No Lambda functions found for stage '$STAGE'."
  exit 0
fi

for fn_arn in $functions; do
  fn_name=$(echo "$fn_arn" | awk -F: '{print $NF}')

  # List all published versions (excludes $LATEST), sorted descending by version number
  versions=$(aws lambda list-versions-by-function \
    --function-name "$fn_name" \
    --query 'Versions[?Version!=`$LATEST`].Version' \
    --output text --region "$REGION" \
    | tr '\t' '\n' \
    | sort -rn)

  version_count=$(echo "$versions" | grep -c . || true)

  if [ "$version_count" -le "$KEEP" ]; then
    echo "OK      $fn_name  ($version_count versions, nothing to prune)"
    continue
  fi

  to_delete=$(echo "$versions" | tail -n +"$((KEEP + 1))")
  delete_count=$(echo "$to_delete" | grep -c . || true)
  echo "PRUNING $fn_name  ($version_count versions → keeping $KEEP, deleting $delete_count)"

  for ver in $to_delete; do
    # Skip a version if provisioned concurrency is configured on it
    pc=$(aws lambda get-provisioned-concurrency-config \
      --function-name "$fn_name" \
      --qualifier "$ver" \
      --region "$REGION" \
      --query 'RequestedProvisionedConcurrentExecutions' \
      --output text 2>/dev/null || echo "")

    if [ -n "$pc" ] && [ "$pc" != "None" ] && [ "$pc" != "0" ]; then
      echo "  SKIP  version $ver (provisioned concurrency=$pc)"
      continue
    fi

    echo "  DELETE version $ver"
    aws lambda delete-function \
      --function-name "$fn_name" \
      --qualifier "$ver" \
      --region "$REGION"
  done
done

echo ""
echo "Done."
