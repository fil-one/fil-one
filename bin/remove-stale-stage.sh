#!/bin/bash
#
# Remove all AWS resources belonging to a given SST stage.
#
# Scans three sources:
#   - Resource Groups Tagging API (regional resources)
#   - IAM roles directly (global, not returned by the tagging API)
#   - CloudFront global resources (also not returned by the tagging API)
#
# Usage:
#   bin/remove-stale-stage.sh <stage>
#
# Arguments:
#   stage   The SST stage name to delete (required)
#
# Environment variables:
#   REGION  AWS region to query (default: us-east-2)

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  awk 'NR==1{next} /^[^#]/{exit} {sub(/^# ?/,"");print}' "$0"
  exit 0
fi

STAGE="${1:?Usage: remove-stale-stage.sh <stage>}"
REGION="${REGION:-us-east-2}"

cf_get_etag() {
  # $1 = get subcommand, $2 = id flag (--id or --name), $3 = id value
  aws cloudfront "$1" "$2" "$3" --query 'ETag' --output text 2>/dev/null
}

cf_delete_with_etag() {
  # $1 = kind, $2 = get subcmd, $3 = delete subcmd, $4 = id flag, $5 = id, $6 = display name
  local etag err
  etag=$(cf_get_etag "$2" "$4" "$5")
  if [ -z "$etag" ] || [ "$etag" = "None" ]; then
    echo "  WARN: could not fetch ETag for $1 $6 ($5); skipping"
    return 1
  fi
  if err=$(aws cloudfront "$3" "$4" "$5" --if-match "$etag" 2>&1); then
    echo "Deleted $1: $6"
  elif echo "$err" | grep -qE 'InUse|still being used'; then
    echo "  WARN: $1 $6 still in use — re-run in ~15 min after distribution is gone"
  else
    echo "  ERROR deleting $1 $6 ($5):"
    echo "$err" | sed 's/^/    /'
    return 1
  fi
}

delete_iam_role() {
  local name="$1"
  echo "Deleting IAM Role: $name"
  # Remove instance profiles
  profiles=$(aws iam list-instance-profiles-for-role --role-name "$name" \
    --query 'InstanceProfiles[].InstanceProfileName' --output text 2>/dev/null)
  for profile in $profiles; do
    aws iam remove-role-from-instance-profile --role-name "$name" --instance-profile-name "$profile"
  done
  # Detach managed policies
  policies=$(aws iam list-attached-role-policies --role-name "$name" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null)
  for policy in $policies; do
    aws iam detach-role-policy --role-name "$name" --policy-arn "$policy"
  done
  # Delete inline policies
  inline=$(aws iam list-role-policies --role-name "$name" \
    --query 'PolicyNames[]' --output text 2>/dev/null)
  for policy in $inline; do
    aws iam delete-role-policy --role-name "$name" --policy-name "$policy"
  done
  aws iam delete-role --role-name "$name"
}

# --- Phase 1: Regional resources via tagging API ---

echo "=== Phase 1: Regional resources (tagging API) ==="

ARNS=$(aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=sst:stage,Values="$STAGE" \
  --query 'ResourceTagMappingList[].ResourceARN' \
  --output text --region "$REGION")

# 1a. CloudFormation stacks — must delete before the per-ARN loop. SetupStack
# (from sst.config.ts) contains a Custom::FiloneSetup resource whose Delete
# handler invokes the SetupIntegrations Lambda. If the loop deletes that Lambda
# first, CloudFormation can't invoke it and the stack lands in DELETE_FAILED.
# Deletion is async — re-run the script if a stack ends up stuck.
stack_names=$(echo "$ARNS" | tr '[:space:]' '\n' \
  | grep -E ':cloudformation:[^:]*:[0-9]+:stack/' \
  | awk -F/ '{print $(NF-1)}' | sort -u)
for name in $stack_names; do
  status=$(aws cloudformation describe-stacks --stack-name "$name" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
  case "$status" in
    DELETE_IN_PROGRESS)
      echo "Stack $name is already deleting — skipping, re-run later if needed"
      ;;
    DELETE_FAILED)
      echo "Stack $name is DELETE_FAILED — retrying with FORCE_DELETE_STACK"
      aws cloudformation delete-stack --stack-name "$name" \
        --deletion-mode FORCE_DELETE_STACK --region "$REGION"
      ;;
    *)
      echo "Deleting CloudFormation Stack: $name (status: $status, async — re-run if it lands in DELETE_FAILED)"
      aws cloudformation delete-stack --stack-name "$name" --region "$REGION"
      ;;
  esac
done

if [ -z "$ARNS" ]; then
  echo "No regional resources found for stage '$STAGE'."
else
  for arn in $ARNS; do
    echo "Processing: $arn"

    case $arn in
      *:cloudformation:*:stack/*)
        : # already handled before the loop (see 1a above)
        ;;
      *:apigateway:*/apis/*/stages/*)
        echo "Skipping stage (deleted with API): $arn"
        ;;
      *:apigateway:*/apis/*)
        id=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting API Gateway: $id"
        aws apigatewayv2 delete-api --api-id "$id" --region "$REGION" > /dev/null 2>&1
        ;;
      *:lambda:*:event-source-mapping:*)
        uuid=$(echo "$arn" | awk -F: '{print $NF}')
        echo "Deleting Lambda Event Source Mapping: $uuid"
        aws lambda delete-event-source-mapping --uuid "$uuid" --region "$REGION" > /dev/null 2>&1
        ;;
      *:function:*)
        name=$(echo "$arn" | awk -F: '{print $NF}')
        echo "Deleting Lambda: $name"
        aws lambda delete-function --function-name "$name" --region "$REGION" > /dev/null 2>&1
        ;;
      *:firehose:*:deliverystream/*)
        name=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting Firehose Delivery Stream: $name"
        aws firehose delete-delivery-stream --delivery-stream-name "$name" --region "$REGION"
        ;;
      *:log-group:*)
        name=$(echo "$arn" | sed 's/.*:log-group://' | sed 's/:\*//')
        echo "Deleting Log Group: $name"
        aws logs delete-log-group --log-group-name "$name" --region "$REGION"
        ;;
      *:table/*)
        name=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting DynamoDB Table: $name"
        aws dynamodb delete-table --table-name "$name" --region "$REGION" > /dev/null 2>&1
        ;;
      *:rule/*)
        name=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting EventBridge Rule: $name"
        targets=$(aws events list-targets-by-rule --rule "$name" --region "$REGION" --query 'Targets[].Id' --output text 2>/dev/null)
        if [ -n "$targets" ]; then
          aws events remove-targets --rule "$name" --ids $targets --region "$REGION"
        fi
        aws events delete-rule --name "$name" --region "$REGION"
        ;;
      *:alarm:*)
        name=$(echo "$arn" | awk -F: '{print $NF}')
        echo "Deleting CloudWatch Alarm: $name"
        aws cloudwatch delete-alarms --alarm-names "$name" --region "$REGION"
        ;;
      *:role/*)
        name=$(echo "$arn" | awk -F/ '{print $NF}')
        delete_iam_role "$name"
        ;;
      *s3:::*)
        bucket=$(echo "$arn" | awk -F::: '{print $NF}')
        echo "Deleting S3 Bucket: $bucket"
        aws s3 rb "s3://$bucket" --force
        ;;
      *:event-bus/*)
        name=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting EventBridge Bus: $name"
        aws events delete-event-bus --name "$name" --region "$REGION"
        ;;
      *:sqs:*)
        name=$(echo "$arn" | awk -F: '{print $NF}')
        account=$(echo "$arn" | awk -F: '{print $5}')
        region=$(echo "$arn" | awk -F: '{print $4}')
        url="https://sqs.$region.amazonaws.com/$account/$name"
        echo "Deleting SQS Queue: $name"
        aws sqs delete-queue --queue-url "$url" --region "$REGION"
        ;;
      *)
        echo "UNKNOWN TYPE — delete manually: $arn"
        ;;
    esac
  done
fi

# --- Phase 2: IAM roles (global, not returned by tagging API) ---

echo ""
echo "=== Phase 2: IAM roles (direct scan) ==="

# Collect all IAM roles that could belong to SST stages.
# SST uses multiple naming conventions:
#   - filone-<stage>-*   (current app name)
#   - hyperspace-<stage>-* (old app name)
#   - <stage>-*          (SQS subscriber function roles)
all_roles=$(aws iam list-roles --max-items 1000 \
  --query 'Roles[].RoleName' --output text | tr '\t' '\n')

iam_role_count=0
while IFS= read -r role_name; do
  [ -z "$role_name" ] && continue
  stage_tag=$(aws iam list-role-tags --role-name "$role_name" \
    --query 'Tags[?Key==`sst:stage`].Value | [0]' --output text 2>/dev/null)
  if [ "$stage_tag" = "$STAGE" ]; then
    delete_iam_role "$role_name"
    iam_role_count=$((iam_role_count + 1))
  fi
done < <(echo "$all_roles" | grep -E "^(filone-${STAGE}-|hyperspace-${STAGE}-|${STAGE}-)")

# Also catch roles that don't match the name pattern but are tagged with
# this stage (e.g. CwToFirehoseRole-*, OtelFirehoseRole-*, MetricFirehoseRole-*).
while IFS= read -r role_name; do
  [ -z "$role_name" ] && continue
  # Skip roles already handled by name-prefix match above
  echo "$role_name" | grep -qE "^(filone-${STAGE}-|hyperspace-${STAGE}-|${STAGE}-)" && continue
  stage_tag=$(aws iam list-role-tags --role-name "$role_name" \
    --query 'Tags[?Key==`sst:stage`].Value | [0]' --output text 2>/dev/null)
  if [ "$stage_tag" = "$STAGE" ]; then
    delete_iam_role "$role_name"
    iam_role_count=$((iam_role_count + 1))
  fi
done < <(echo "$all_roles" | grep -E '(FirehoseRole-|MetricStreamRole-|FunctionRole-)')

if [ "$iam_role_count" -eq 0 ]; then
  echo "No IAM roles found for stage '$STAGE'."
else
  echo "Deleted $iam_role_count IAM role(s)."
fi

# --- Phase 3: CloudFront global resources ---
#
# CloudFront is global, so the regional tagging API in Phase 1 never returns
# its resources. Without this phase, custom Response Headers Policies leak
# and eventually hit the 20-per-account cap.

echo ""
echo "=== Phase 3: CloudFront global resources ==="

# 3a. Distributions tagged sst:stage=<STAGE>.
# Distributions need disable -> wait ~15min -> delete. We disable and exit;
# the user re-runs once Status returns to Deployed.
dist_match_count=0
while IFS= read -r arn; do
  [ -z "$arn" ] && continue
  stage_tag=$(aws cloudfront list-tags-for-resource --resource "$arn" \
    --query 'Tags.Items[?Key==`sst:stage`].Value | [0]' --output text 2>/dev/null)
  [ "$stage_tag" != "$STAGE" ] && continue
  dist_match_count=$((dist_match_count + 1))

  id=$(echo "$arn" | awk -F/ '{print $NF}')
  status=$(aws cloudfront get-distribution --id "$id" \
    --query 'Distribution.Status' --output text 2>/dev/null)
  enabled=$(aws cloudfront get-distribution --id "$id" \
    --query 'Distribution.DistributionConfig.Enabled' --output text 2>/dev/null)

  if [ "$status" != "Deployed" ]; then
    echo "  WARN: distribution $id is $status — skipping, re-run later"
    continue
  fi

  if [ "$enabled" = "True" ]; then
    echo "  Disabling distribution $id (re-run script in ~15 min to delete)"
    cfg=$(mktemp)
    aws cloudfront get-distribution-config --id "$id" --output json > "$cfg"
    etag=$(jq -r '.ETag' "$cfg")
    jq '.DistributionConfig | .Enabled = false' "$cfg" > "$cfg.new"
    aws cloudfront update-distribution --id "$id" --if-match "$etag" \
      --distribution-config "file://$cfg.new" > /dev/null
    rm -f "$cfg" "$cfg.new"
  else
    etag=$(cf_get_etag get-distribution --id "$id")
    echo "Deleting Distribution: $id"
    aws cloudfront delete-distribution --id "$id" --if-match "$etag"
  fi
done < <(aws cloudfront list-distributions \
  --query 'DistributionList.Items[].ARN' --output text 2>/dev/null | tr '\t' '\n')
[ "$dist_match_count" -eq 0 ] && echo "No CloudFront distributions found for stage '$STAGE'."

# 3b. Response Headers Policy (deterministic name from sst.config.ts)
policy_name="filone-${STAGE}-security-headers"
policy_id=$(aws cloudfront list-response-headers-policies --type custom \
  --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='${policy_name}'].ResponseHeadersPolicy.Id | [0]" \
  --output text 2>/dev/null)
if [ -n "$policy_id" ] && [ "$policy_id" != "None" ]; then
  cf_delete_with_etag "Response Headers Policy" get-response-headers-policy \
    delete-response-headers-policy --id "$policy_id" "$policy_name"
else
  echo "No Response Headers Policy found for stage '$STAGE'."
fi

# 3c. Cache Policies (custom) by name prefix
cache_count=0
while IFS=$'\t' read -r cp_id cp_name; do
  [ -z "$cp_id" ] && continue
  case "$cp_name" in
    filone-${STAGE}-*|hyperspace-${STAGE}-*|${STAGE}-*)
      cf_delete_with_etag "Cache Policy" get-cache-policy \
        delete-cache-policy --id "$cp_id" "$cp_name"
      cache_count=$((cache_count + 1))
      ;;
  esac
done < <(aws cloudfront list-cache-policies --type custom \
  --query 'CachePolicyList.Items[].CachePolicy.{Id:Id,Name:CachePolicyConfig.Name}' \
  --output text 2>/dev/null)
[ "$cache_count" -eq 0 ] && echo "No Cache Policies found for stage '$STAGE'."

# 3d. Origin Request Policies (custom) by name prefix
orp_count=0
while IFS=$'\t' read -r orp_id orp_name; do
  [ -z "$orp_id" ] && continue
  case "$orp_name" in
    filone-${STAGE}-*|hyperspace-${STAGE}-*|${STAGE}-*)
      cf_delete_with_etag "Origin Request Policy" get-origin-request-policy \
        delete-origin-request-policy --id "$orp_id" "$orp_name"
      orp_count=$((orp_count + 1))
      ;;
  esac
done < <(aws cloudfront list-origin-request-policies --type custom \
  --query 'OriginRequestPolicyList.Items[].OriginRequestPolicy.{Id:Id,Name:OriginRequestPolicyConfig.Name}' \
  --output text 2>/dev/null)
[ "$orp_count" -eq 0 ] && echo "No Origin Request Policies found for stage '$STAGE'."

# 3e. CloudFront Functions by name prefix (functions don't support tags)
fn_count=0
while IFS= read -r fn_name; do
  [ -z "$fn_name" ] && continue
  case "$fn_name" in
    filone-${STAGE}-*|hyperspace-${STAGE}-*|${STAGE}-*)
      cf_delete_with_etag "CloudFront Function" describe-function \
        delete-function --name "$fn_name" "$fn_name"
      fn_count=$((fn_count + 1))
      ;;
  esac
done < <(aws cloudfront list-functions \
  --query 'FunctionList.Items[].Name' --output text 2>/dev/null \
  | tr '\t' '\n' | sort -u)
[ "$fn_count" -eq 0 ] && echo "No CloudFront Functions found for stage '$STAGE'."

# 3f. Origin Access Controls by name prefix
oac_count=0
while IFS=$'\t' read -r oac_id oac_name; do
  [ -z "$oac_id" ] && continue
  case "$oac_name" in
    filone-${STAGE}-*|hyperspace-${STAGE}-*|${STAGE}-*)
      cf_delete_with_etag "Origin Access Control" get-origin-access-control \
        delete-origin-access-control --id "$oac_id" "$oac_name"
      oac_count=$((oac_count + 1))
      ;;
  esac
done < <(aws cloudfront list-origin-access-controls \
  --query 'OriginAccessControlList.Items[].{Id:Id,Name:Name}' \
  --output text 2>/dev/null)
[ "$oac_count" -eq 0 ] && echo "No Origin Access Controls found for stage '$STAGE'."

echo ""
echo "Done removing stage '$STAGE'."
