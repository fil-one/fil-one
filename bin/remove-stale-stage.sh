#!/bin/bash
#
# Remove all AWS resources belonging to a given SST stage.
#
# Scans both the Resource Groups Tagging API (regional resources) and
# IAM roles directly (global resources not returned by the tagging API).
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

if [ -z "$ARNS" ]; then
  echo "No regional resources found for stage '$STAGE'."
else
  for arn in $ARNS; do
    echo "Processing: $arn"

    case $arn in
      *:apigateway:*/apis/*/stages/*)
        echo "Skipping stage (deleted with API): $arn"
        ;;
      *:apigateway:*/apis/*)
        id=$(echo "$arn" | awk -F/ '{print $NF}')
        echo "Deleting API Gateway: $id"
        aws apigatewayv2 delete-api --api-id "$id" --region "$REGION" > /dev/null 2>&1
        ;;
      *:function:*)
        name=$(echo "$arn" | awk -F: '{print $NF}')
        echo "Deleting Lambda: $name"
        aws lambda delete-function --function-name "$name" --region "$REGION" > /dev/null 2>&1
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

echo ""
echo "Done removing stage '$STAGE'."
