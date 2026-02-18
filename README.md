# Hyperspace

Full-stack prototype — npm workspaces monorepo deploying to AWS (S3 + CloudFront, API Gateway + Lambda, DynamoDB).

## Structure

```
hyperspace/
├── packages/
│   ├── shared/     # TypeScript interfaces shared between website and backend
│   ├── backend/    # Lambda handlers (upload → DynamoDB)
│   ├── infra/      # AWS CDK stacks (domain, database, api, website)
│   └── website/    # Vite + React + TanStack Router SPA
```

## AWS account

| | |
|---|---|
| Account | `654654381893` |
| Region | `us-east-2` |
| SSO portal | https://d-9067ff87d6.awsapps.com/start |

## Setup

**1. Configure the AWS profile (one-time)**

```bash
aws configure sso --profile hyperspace
```

When prompted:
- SSO start URL: `https://d-9067ff87d6.awsapps.com/start`
- SSO region: `us-east-1`
- Account ID: `654654381893`
- Role: `PowerUserAccess`
- Default region: `us-east-2`
- Output format: `json`

**2. Log in at the start of each session**

```bash
aws sso login --profile hyperspace
```

**3. Install dependencies**

```bash
npm install
```

**4. Set the API URL for local dev**

```bash
echo "VITE_API_URL=https://<api-id>.execute-api.us-east-2.amazonaws.com" > packages/website/.env.local
```

## Commands

```bash
npm run build       # shared → backend → website → cdk synth (in order)
npm run deploy      # build + cdk deploy --all
npm run typecheck   # tsc --noEmit across all packages
```

```bash
# Local dev server
cd packages/website && npm run dev

# Manual CloudFront cache invalidation
aws cloudfront create-invalidation \
  --distribution-id <id> --paths "/*" --profile=hyperspace
```

## Stacks

| Stack | Resources |
|---|---|
| `HyperspaceDomainStack` | Route53 hosted zone for `hyperspace.filecoin.dev` |
| `HyperspaceDatabaseStack` | DynamoDB table `hyperspace-uploads` |
| `HyperspaceApiStack` | API Gateway HTTP API + Lambda upload handler |
| `HyperspaceWebsiteStack` | S3 + CloudFront distribution + Route53 alias |

> **DNS delegation pending** — after deploying `HyperspaceDomainStack`, add the `HyperspaceDelegationNameServers` output as an NS record for `hyperspace.filecoin.dev` in the `filecoin.dev` hosted zone. Once live, re-enable the ACM certificate in `domain-stack.ts`.
