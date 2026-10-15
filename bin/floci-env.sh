# Source to point the AWS SDK, CLI and SST at floci: its fixed endpoint and
# placeholder credentials (what `floci env` prints).
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost.floci.io:4566}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
export AWS_REGION="${AWS_REGION:-us-east-1}"
unset AWS_PROFILE
