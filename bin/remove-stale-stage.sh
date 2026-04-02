#!/bin/bash
#
# Remove all AWS resources belonging to a given SST stage.
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

ARNS=$(aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=sst:stage,Values=$STAGE \
  --query 'ResourceTagMappingList[].ResourceARN' \
  --output text --region $REGION)

for arn in $ARNS; do
  echo "Processing: $arn"

  case $arn in
    *:apigateway:*/apis/*/stages/*)
      echo "Skipping stage (deleted with API): $arn"
      ;;
    *:apigateway:*/apis/*)
      id=$(echo "$arn" | awk -F/ '{print $NF}')
      echo "Deleting API Gateway: $id"
      aws apigatewayv2 delete-api --api-id "$id" --region $REGION > /dev/null 2>&1
      ;;
    *:function:*)
      name=$(echo "$arn" | awk -F: '{print $NF}')
      echo "Deleting Lambda: $name"
      aws lambda delete-function --function-name "$name" --region $REGION > /dev/null 2>&1
      ;;
    *:log-group:*)
      name=$(echo "$arn" | sed 's/.*:log-group://' | sed 's/:\*//')
      echo "Deleting Log Group: $name"
      aws logs delete-log-group --log-group-name "$name" --region $REGION
      ;;
    *:table/*)
      name=$(echo "$arn" | awk -F/ '{print $NF}')
      echo "Deleting DynamoDB Table: $name"
      aws dynamodb delete-table --table-name "$name" --region $REGION > /dev/null 2>&1
      ;;
    *:rule/*)
      name=$(echo "$arn" | awk -F/ '{print $NF}')
      echo "Deleting EventBridge Rule: $name"
      targets=$(aws events list-targets-by-rule --rule "$name" --region $REGION --query 'Targets[].Id' --output text 2>/dev/null)
      if [ -n "$targets" ]; then
        aws events remove-targets --rule "$name" --ids $targets --region $REGION
      fi
      aws events delete-rule --name "$name" --region $REGION
      ;;
    *:alarm:*)
      name=$(echo "$arn" | awk -F: '{print $NF}')
      echo "Deleting CloudWatch Alarm: $name"
      aws cloudwatch delete-alarms --alarm-names "$name" --region $REGION
      ;;
    *:role/*)
      name=$(echo "$arn" | awk -F/ '{print $NF}')
      echo "Deleting IAM Role: $name"
      policies=$(aws iam list-attached-role-policies --role-name "$name" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null)
      for policy in $policies; do
        aws iam detach-role-policy --role-name "$name" --policy-arn "$policy"
      done
      inline=$(aws iam list-role-policies --role-name "$name" --query 'PolicyNames[]' --output text 2>/dev/null)
      for policy in $inline; do
        aws iam delete-role-policy --role-name "$name" --policy-name "$policy"
      done
      aws iam delete-role --role-name "$name"
      ;;
    *s3:::*)
      bucket=$(echo "$arn" | awk -F::: '{print $NF}')
      echo "Deleting S3 Bucket: $bucket"
      aws s3 rb "s3://$bucket" --force
      ;;
    *:event-bus/*)
      name=$(echo "$arn" | awk -F/ '{print $NF}')
      echo "Deleting EventBridge Bus: $name"
      aws events delete-event-bus --name "$name" --region $REGION
      ;;
    *:sqs:*)
      name=$(echo "$arn" | awk -F: '{print $NF}')
      account=$(echo "$arn" | awk -F: '{print $5}')
      region=$(echo "$arn" | awk -F: '{print $4}')
      url="https://sqs.$region.amazonaws.com/$account/$name"
      echo "Deleting SQS Queue: $name"
      aws sqs delete-queue --queue-url "$url" --region $REGION
      ;;
    *)
      echo "UNKNOWN TYPE — delete manually: $arn"
      ;;
  esac
done
