# Hyperspace

Full-stack prototype — npm workspaces monorepo deploying to AWS via [SST v3](https://sst.dev/).

## Structure

```
hyperspace/
├── sst.config.ts  # SST v3 infrastructure (replaces CDK stacks)
├── packages/
│   ├── shared/     # TypeScript interfaces shared between website and backend
│   ├── backend/    # Lambda handlers (upload → DynamoDB)
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

## Prerequisites

- **Node.js** >= 20
- **AWS CLI** — required for S3 sync and CloudFront invalidation during deploy. [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

## Setup

**1. Configure the AWS profile (one-time)**

```bash
aws configure sso --profile hyperspace
```

When prompted:

- SSO Session name: `hyperspace-sandbox`
- SSO start URL: `https://d-9067ff87d6.awsapps.com/start`
- SSO region: `us-east-1`
- SSO registration scopes: `sso:account:access`
- Account ID: `654654381893`
- Role: `AdministratorAccess`
- Default region: `us-east-2` - Or whatever region you want.
- Output format: `json`

**2. Log in and activate the profile**

*MUST do this before you can deploy.*

```bash
aws sso login --profile hyperspace
```

Then set the profile for your shell session so SST picks it up:

```bash
export AWS_PROFILE=hyperspace
```

To make this permanent, add it to your shell config:

```bash
# Add to ~/.zshrc (or ~/.bashrc)
echo 'export AWS_PROFILE=hyperspace' >> ~/.zshrc
source ~/.zshrc
```

You can verify it's working with:

```bash
aws sts get-caller-identity
```

**3. Initialize submodules**

```bash
git submodule update --init --recursive
```

**4. Install dependencies**

```bash
npm install
```

**5. Set SST secrets (one-time per stage)**

```bash
npx sst secret set Auth0ClientId <value> [--stage <stage>]
npx sst secret set Auth0ClientSecret <value> [--stage <stage>]
npx sst secret set Auth0MgmtClientId <value> [--stage <stage>]
npx sst secret set Auth0MgmtClientSecret <value> [--stage <stage>]
npx sst secret set StripeSecretKey <value> [--stage <stage>]
npx sst secret set StripePriceId <value> [--stage <stage>]
```

Omit `--stage` to set for your personal dev stage (defaults to OS username).

The `Auth0MgmtClientId` and `Auth0MgmtClientSecret` are from a **Machine-to-Machine (M2M) application** in Auth0 — see the [Auth0 M2M Setup](#auth0-machine-to-machine-m2m-application) section below.

## Commands

```bash
npm run dev              # SST live dev mode (live Lambda debugging)
npm run deploy           # Deploy personal dev stack (uses OS username as stage)
npm run deploy:staging   # Deploy to staging.filhyperspace.com
npm run deploy:production # Deploy to console.filhyperspace.com
npm run remove           # Remove your personal dev stack
npm run typecheck        # tsc --noEmit across all packages
```

```bash
# Local website dev server (for frontend-only changes)
cd packages/website && npm run dev
```

### Personal Dev Stack

```bash
npx sst deploy
```

Uses your OS username as the stage name. No custom domain — outputs a CloudFront URL.

### Staging / Production

```bash
npx sst deploy --stage staging
npx sst deploy --stage production
```

Custom domains require a pre-provisioned ACM certificate in us-east-1 and a DNS CNAME pointing to the CloudFront distribution (managed by a separate pipeline).

### Live Dev Mode

```bash
npx sst dev
```

Runs Lambda functions locally with live reload. Changes to handler code take effect immediately without redeploying.

## ACM Certificate Provisioning

Custom domains require an ACM certificate in **us-east-1** (CloudFront requirement):

1. Go to AWS Certificate Manager in the us-east-1 region
2. Request a public certificate for the domain (e.g. `console.filhyperspace.com`)
3. Complete DNS validation by adding the provided CNAME record
4. The `sst.config.ts` looks up the certificate by domain name automatically

## DNS Setup

DNS is managed by a separate pipeline. After deploying, create a CNAME record pointing the custom domain to the CloudFront distribution domain name shown in the deploy output.

## Auth0

| | |
|---|---|
| Dev environment | **FilHyperspaceDev** |
| Tenant domain | `dev-oar2nhqh58xf5pwf.us.auth0.com` |
| Dashboard | https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ/settings |

Auth0 credentials are managed as SST secrets (`Auth0ClientId`, `Auth0ClientSecret`). See the "Set SST secrets" step above.

**Callback and logout URLs are configured automatically during deploy** — no manual Dashboard edits needed. The deploy-time setup Lambda adds the correct URLs for the deployed domain (custom domain or CloudFront).

**Application settings** (Applications > your app > Settings):
- Under **Advanced Settings > Grant Types**, ensure **Authorization Code** and **Refresh Token** are enabled.

**API setup** (APIs > Create API):
- **Identifier (audience)**: `console.filhyperspace.com` — this must match `AUTH0_AUDIENCE` in `sst.config.ts` and website env. It's what makes Auth0 issue a JWT access token (instead of an opaque one) and is the `aud` claim the middleware validates.
- Under the API's **Machine to Machine Applications** tab, authorize your application so it can exchange tokens.

### Auth0 Machine-to-Machine (M2M) Application

The deploy automation uses an M2M application to update Auth0 settings programmatically.

**One-time setup in Auth0 Dashboard:**

1. Go to **Applications > Create Application**
2. Choose **Machine to Machine Applications**
3. Name it something like `Hyperspace Deploy Automation`
4. Authorize it for the **Auth0 Management API** (`https://<tenant>.us.auth0.com/api/v2/`)
5. Grant these scopes: `read:clients`, `update:clients`
6. Copy the **Client ID** and **Client Secret**

Set these as SST secrets:
```bash
npx sst secret set Auth0MgmtClientId <M2M-client-id> [--stage <stage>]
npx sst secret set Auth0MgmtClientSecret <M2M-client-secret> [--stage <stage>]
```

## Stripe (Billing)

### 1. Create the product in Stripe Dashboard

Use **test mode** first. Switch to live mode for production.

1. **Products > Add product**
   - Name: `Hyperspace Storage`
   - Description: `Decentralized cloud storage — $4.99/TiB/month`
2. **Add price** on that product:
   - Pricing model: Standard
   - Recurring: Monthly
   - Usage type: **Metered** (sum of usage values during period)
   - Price: `$4.99` per unit, unit label: `TiB`
3. Note the **Price ID** (`price_xxxxx`)

### 2. Configure Customer Portal

**Settings > Billing > Customer portal** — enable:
- Update payment method
- View billing history / invoices
- Cancel subscription

### 3. Webhooks (automated)

**Webhook endpoints are created and managed automatically during deploy.** The deploy-time setup Lambda creates the Stripe webhook endpoint with the correct URL for the deployed domain and stores the signing secret in AWS SSM Parameter Store. No manual configuration needed.

Events registered: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.payment_succeeded`, `invoice.payment_failed`

### 4. Secrets

Stripe credentials are managed as SST secrets (`StripeSecretKey`, `StripePriceId`). See the "Set SST secrets" step above.

The frontend needs the **publishable key** in its env:

```bash
# packages/website/.env.local
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_xxxxx
```

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
