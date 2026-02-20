# Hyperspace

Full-stack prototype — npm workspaces monorepo deploying to AWS (S3 + CloudFront, API Gateway + Lambda, DynamoDB).

## Structure

```
hyperspace/
├── packages/
│   ├── shared/     # TypeScript interfaces shared between website and backend
│   ├── backend/    # Lambda handlers (upload → DynamoDB)
│   ├── infra/      # AWS CDK stacks (domain, database, api, website)
│   ├── ui/         # UI component library (git submodule → joemocode-business/ui-hyperspace)
│   └── website/    # Vite + React 19 + TanStack Router SPA + Tailwind v4
```

> `packages/ui` is a git submodule — a standalone fork of `@filecoin-foundation/ui-filecoin` adapted for React/Vite. The upstream fork lives at `joemocode-business/filecoin-foundation` for tracking upstream changes. TODO Move this to something more official and not my Github :) 

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

*MUST do this before you can deploy.*

```bash
aws sso login --profile hyperspace
```

**3. Initialize submodules**

```bash
git submodule update --init --recursive
```

**4. Install dependencies**

```bash
npm install
```

**5. Set the API URL for local dev**

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
| `HyperspaceDomainStack` | Route53 hosted zone for `*.filhyperspace.com` |
| `HyperspaceDatabaseStack` | DynamoDB table `hyperspace-uploads` |
| `HyperspaceApiStack` | API Gateway HTTP API + Lambda upload handler |
| `HyperspaceWebsiteStack` | S3 + CloudFront distribution + Route53 alias |

## UI submodule (`packages/ui`)

`packages/ui` is a git submodule pointing to `joemocode-business/ui-hyperspace` — a fork of `@filecoin-foundation/ui-filecoin` adapted for Vite/React. It is consumed from source by the website (no separate build step in dev).

**Importing components in the website**

```tsx
import { Button } from '@hyperspace/ui/Button'
import { Section } from '@hyperspace/ui/Section/Section'
import { Heading } from '@hyperspace/ui/Heading'
```

Styles are loaded globally via `packages/website/src/styles.css` which imports `@hyperspace/ui/styles` (Tailwind v4 theme + component CSS).

**Updating the submodule to a new commit**

```bash
cd packages/ui
git pull origin main
cd ../..
git add packages/ui
git commit -m "chore: bump ui submodule"
```

**Pulling upstream changes from the original library**

The full fork at `joemocode-business/filecoin-foundation` tracks the upstream `FilecoinFoundationWeb/filecoin-foundation`. To bring in upstream changes:

```bash
# In the filecoin-foundation fork, sync upstream then cherry-pick or copy
# changed files from packages/ui-filecoin/ into the ui-hyperspace repo manually.
```

> **Note**: Several components in `packages/ui` use Next.js-specific APIs (`next/navigation`, `next/image`) or `nuqs` and are not usable as-is in this Vite app. These include `Navigation/*`, `Network/*`, and `Search/Search`. They will be adapted for React Router as needed.

## Stacks — after deploying `HyperspaceDomainStack`, add the `HyperspaceDelegationNameServers` output as an NS record for `console.filhyperspace.com` in the `filhyperspace.com` hosted zone. Once live, re-enable the ACM certificate in `domain-stack.ts`.
