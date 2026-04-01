#!/bin/bash
#
# Find SST stages whose corresponding PRs are no longer open.
#
# Usage:
#   bin/find-stale-stages.sh
#
# Environment variables:
#   REGION  AWS region to query (default: us-east-2)
#   REPO    GitHub owner/repo to check PRs against
#           (default: auto-detected from current git remote)

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,"");print}' "$0"
  exit 0
fi

REGION="${REGION:-us-east-2}"
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)}"

if [ -z "$REPO" ]; then
  echo "Error: could not detect repository. Set REPO=owner/repo or run from a GitHub-connected repo." >&2
  exit 1
fi

# Get all unique stages from tagged resources
stages=$(aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=sst:stage \
  --query 'ResourceTagMappingList[].Tags[?Key==`sst:stage`].Value' \
  --output text --region $REGION | tr '\t' '\n' | sort -u)

echo "Checking stages..."
echo ""

for stage in $stages; do
  # Skip staging
  if [ "$stage" = "staging" ]; then
    echo "KEEP    $stage (protected)"
    continue
  fi

  # Extract PR number if stage matches pr-NNN pattern
  if [[ "$stage" =~ ^pr-([0-9]+)$ ]]; then
    pr_number="${BASH_REMATCH[1]}"
    state=$(gh pr view "$pr_number" --repo "$REPO" --json state --jq '.state' 2>/dev/null)

    if [ "$state" = "OPEN" ]; then
      echo "KEEP    $stage (PR #$pr_number is OPEN)"
    else
      echo "STALE  $stage (PR #$pr_number is $state)"
    fi
  else
    echo "UNKNOWN $stage (not a PR stage)"
  fi
done
