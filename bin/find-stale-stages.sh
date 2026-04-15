#!/bin/bash
#
# Find SST stages whose corresponding PRs are no longer open.
#
# Scans both the Resource Groups Tagging API (regional resources) and
# IAM roles directly (global resources not returned by the tagging API).
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

# Get unique stages from the tagging API (regional resources)
tagging_stages=$(aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=sst:stage \
  --query 'ResourceTagMappingList[].Tags[?Key==`sst:stage`].Value' \
  --output text --region "$REGION" | tr '\t' '\n' | sort -u)

# Get unique stages from IAM role tags (global — not returned by tagging API)
echo "Scanning IAM roles for sst:stage tags (this may take a moment)..."
iam_stages=""
while IFS= read -r role_name; do
  stage=$(aws iam list-role-tags --role-name "$role_name" \
    --query 'Tags[?Key==`sst:stage`].Value | [0]' --output text 2>/dev/null)
  if [ -n "$stage" ] && [ "$stage" != "None" ]; then
    iam_stages="$iam_stages"$'\n'"$stage"
  fi
done < <(aws iam list-roles \
  --query 'Roles[?contains(RoleName, `filone-`) || contains(RoleName, `hyperspace-`) || contains(RoleName, `pr-`) || contains(RoleName, `srdj-`) || contains(RoleName, `bajt-`)].RoleName' \
  --output text | tr '\t' '\n')

# Merge and deduplicate
stages=$(printf '%s\n%s' "$tagging_stages" "$iam_stages" | grep -v '^$' | sort -u)

echo ""
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
    echo "UNKNOWN $stage (not a PR stage — may be a dev stage)"
  fi
done
