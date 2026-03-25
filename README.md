# Fil.one

Full-stack prototype — pnpm workspaces monorepo deploying to AWS via [SST v3](https://sst.dev/).

## Structure

```
hyperspace/
├── sst.config.ts  # SST v3 infrastructure (app stack — API, website, queues, etc.)
├── infra/         # SST v3 infrastructure (base infra — OIDC provider, IAM roles)
├── contracts/     # Foundry smart contracts
├── packages/
│   ├── shared/     # TypeScript interfaces shared between website and backend
│   ├── aurora-backoffice-client/ # Generated TS client for Aurora Back Office API
│   ├── aurora-portal-client/    # Generated TS client for Aurora Portal API
│   ├── backend/    # Lambda handlers (upload → DynamoDB)
│   ├── ui/         # UI component library (git submodule → joemocode-business/ui-hyperspace)
│   └── website/    # Vite + React 19 + TanStack Router SPA + Tailwind v4
```

> `packages/ui` is a git submodule — a standalone fork of `@filecoin-foundation/ui-filecoin` adapted for React/Vite. The upstream fork lives at `joemocode-business/filecoin-foundation` for tracking upstream changes. This package does not build on its own! We import the UI components we use and build through Website package. TODO Move this to something more official and not my Github, probably.

## AWS account

|                     |                                        |
| ------------------- | -------------------------------------- |
| Staging/dev Account | `654654381893`                         |
| Region              | `us-east-2`                            |
| SSO portal          | https://d-9067ff87d6.awsapps.com/start |

## Prerequisites

- **Node.js** >= 24
- **AWS CLI** — required for S3 sync and CloudFront invalidation during deploy. [Install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

## Setup

**1. Configure the AWS profile (one-time)**

```bash
aws configure sso --profile filone
```

When prompted:

- SSO Session name: `filone-sandbox`
- SSO start URL: `https://d-9067ff87d6.awsapps.com/start`
- SSO region: `us-east-1`
- SSO registration scopes: `sso:account:access`
- Account ID: `654654381893`
- Role: `AdministratorAccess`
- Default region: `us-east-2` - Or whatever region you want.
- Output format: `json`

**2. Log in and activate the profile**

_MUST do this before you can deploy._

```bash
aws sso login --profile filone
```

Then set the profile for your shell session so SST picks it up:

```bash
export AWS_PROFILE=filone
```

To make this permanent, add it to your shell config:

```bash
# Add to ~/.zshrc (or ~/.bashrc)
echo 'export AWS_PROFILE=filone' >> ~/.zshrc
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
pnpm install
```

**5. Set SST secrets (one-time per stage)**

```bash
pnpx sst secret set Auth0ClientId <value> [--stage <stage>]
pnpx sst secret set Auth0ClientSecret <value> [--stage <stage>]
pnpx sst secret set Auth0MgmtClientId <value> [--stage <stage>]
pnpx sst secret set Auth0MgmtClientSecret <value> [--stage <stage>]
pnpx sst secret set StripeSecretKey <value> [--stage <stage>]
pnpx sst secret set StripePriceId <value> [--stage <stage>]
pnpx sst secret set AuroraBackofficeToken <value> [--stage <stage>]
pnpx sst secret set SendGridApiKey <value> [--stage <stage>]
pnpx sst secret set GrafanaLokiAuth '<instanceId>:<apiKey>' [--stage <stage>]
```

Omit `--stage` to set for your personal dev stage (defaults to OS username).

The `Auth0MgmtClientId` and `Auth0MgmtClientSecret` are from a **Machine-to-Machine (M2M) application** in Auth0 — see the [Auth0 M2M Setup](#auth0-machine-to-machine-m2m-application) section below. The `AuroraBackofficeToken` is from the Aurora Back Office dashboard — see the [API token](#api-token) section below. The `GrafanaLokiAuth` secret is from Grafana Cloud — see the [Observability](#observability) section below.

## Commands

```bash
pnpm run dev              # SST live dev mode (live Lambda debugging)
pnpm run deploy           # Deploy personal dev stack (uses OS username as stage)
pnpm run deploy:staging   # Deploy to staging.fil.one
pnpm run deploy:production      # Deploy to console.fil.one
pnpm run deploy:infra:staging   # Deploy base infra (OIDC, IAM) to staging
pnpm run deploy:infra:production # Deploy base infra (OIDC, IAM) to production
pnpm run remove           # Remove your personal dev stack
pnpm run lint             # Lint and typecheck TypeScript code (via oxlint)
pnpm run lint:fix         # Lint and auto-fix where possible
```

```bash
# Local website dev server (for frontend-only changes)
cd packages/website && pnpm run dev
```

### E2E Tests

The repo includes a Playwright end-to-end test suite under `tests/e2e/`. The `@playwright/test` package is already a devDependency, so `pnpm install` covers it.

**Install browser binaries** (one-time):

```bash
pnpm exec playwright install --with-deps
```

**Run tests** against a deployed stage:

```bash
BASE_URL=<your-cloudfront-url> pnpm test:e2e
```

`BASE_URL` is required and should point to a deployed SST stage (personal dev stack, staging, etc.).

After a run, an HTML report is generated at `playwright-report/`. To view it:

```bash
pnpm exec playwright show-report
```

> CI runs these tests automatically against preview deployments on PRs.

### Integration Tests

Integration tests, located in tests/integration/, confirm that individual modules or services interact correctly with one another — for instance, ensuring Stripe webhook handlers produce the expected state transitions in DynamoDB — by running against real AWS and Stripe resources.

While E2E tests (Playwright) cover full, business-critical user journeys spanning the entire system, integration tests focus more narrowly on backend logic at specific integration points.

**Run tests** (requires deployed SST stage):

```bash
pnpm test:integration
```

Tests run inside `sst shell` so that SST resource bindings (table names, Stripe keys, etc.) are available as environment variables.

### Personal Dev Stack

```bash
pnpx sst deploy
```

Uses your OS username as the stage name. No custom domain — outputs a CloudFront URL.

If you are having trouble deploying after SST Changes (eg, a version bump of SST or drift on components from manual actions), you may need to refresh the stack. To do this:

`pnpm run refresh`

Then deploy: `pnpm run deploy`

### Staging / Production

```bash
pnpx sst deploy --stage staging
pnpx sst deploy --stage production
```

Custom domains require a pre-provisioned ACM certificate in us-east-1 and a DNS CNAME pointing to the CloudFront distribution (managed by a separate pipeline).

### Live Dev Mode

```bash
pnpx sst dev
```

Runs Lambda functions locally with live reload. Changes to handler code take effect immediately without redeploying.

## ACM Certificate Provisioning & DNS Setup

Custom domains require an ACM certificate in **us-east-1** (CloudFront requirement):

We manage this in another repo: https://github.com/FilecoinFoundationWeb/FilHyperspace-Infrastructure

Example PR To add `staging.fil.one`: https://github.com/FilecoinFoundationWeb/FilHyperspace-Infrastructure/pull/3

## Auth0

|                 |                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Dev environment | **FilOneDev**                                                                                                     |
| Tenant domain   | `dev-oar2nhqh58xf5pwf.us.auth0.com`                                                                               |
| Dashboard       | https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ/settings |

Auth0 credentials are managed as SST secrets (`Auth0ClientId`, `Auth0ClientSecret`). See the "Set SST secrets" step above.

**Callback and logout URLs are configured automatically during deploy** — no manual Dashboard edits needed. The deploy-time setup Lambda adds the correct URLs for the deployed domain (custom domain or CloudFront).

**Application settings** (Applications > your app > Settings):

- Under **Advanced Settings > Grant Types**, ensure **Authorization Code** and **Refresh Token** are enabled.

**API setup** (APIs > Create API):

- **Identifier (audience)**: `console.fil.one` (prod) — this must match `AUTH0_AUDIENCE` in `sst.config.ts` and website env. It's what makes Auth0 issue a JWT access token (instead of an opaque one) and is the `aud` claim the middleware validates.
- Under the API's **Machine to Machine Applications** tab, authorize your application so it can exchange tokens.

### Auth0 Machine-to-Machine (M2M) Application

The deploy automation uses an M2M application to update Auth0 settings programmatically.

**One-time setup in Auth0 Dashboard:**

1. Go to **Applications > Create Application**
2. Choose **Machine to Machine Applications**
3. Name it something like `Fil.one Deploy Automation`
4. Authorize it for the **Auth0 Management API** (`https://<tenant>.us.auth0.com/api/v2/`)
5. Grant these scopes: `read:clients`, `update:clients`
6. Copy the **Client ID** and **Client Secret**

Set these as SST secrets:

```bash
pnpx sst secret set Auth0MgmtClientId <M2M-client-id> [--stage <stage>]
pnpx sst secret set Auth0MgmtClientSecret <M2M-client-secret> [--stage <stage>]
```

## Stripe (Billing)

### 1. Create the product in Stripe Dashboard

Use **test mode** first. Switch to live mode for production.

1. **Products > Add product**
   - Name: `Fil.one Storage`
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

## SendGrid (Transactional Email)

Auth0 transactional emails (verification, password reset, etc.) are sent via SendGrid. The deploy-time setup Lambda configures Auth0 to use SendGrid automatically.

API keys are managed at: https://app.sendgrid.com/settings/api_keys

The `SendGridApiKey` SST secret should be a key with **Mail Send** permission only. See the "Set SST secrets" step above.

## Aurora API Clients

The project includes generated TypeScript clients for the Aurora APIs, built
with [Hey API](https://heyapi.dev/):

- **Back Office API** — `packages/aurora-backoffice-client/` (tenant management, admin operations)
- **Portal API** — `packages/aurora-portal-client/` (access keys, buckets, tenant-facing operations)

### API Token

The backend uses an API token to authenticate with the Aurora Back Office API
(e.g., to create tenants on user registration).

**Generating the token:**

1. Log in to the Aurora Back Office dashboard at
   https://backoffice.dev.aur.lu/ff/docs/backoffice-api
2. Navigate to the API token management section
3. Generate a new token with the required permissions

**Setting the SST secret:**

```bash
pnpx sst secret set AuroraBackofficeToken <token> [--stage <stage>]
```

### Regenerating the clients

After API changes, update the relevant Swagger spec and regenerate:

**Back Office client:**

1. Download the updated Swagger spec from
   https://backoffice.dev.aur.lu/ff/docs/backoffice-api (open the page, then
   save the JSON loaded by the page)
2. Replace `packages/aurora-backoffice-client/aurora-backoffice.swagger.json`
   with the downloaded file

**Portal client:**

Download the updated Swagger spec from the Aurora Portal API docs and save it to `packages/aurora-portal-client/aurora-portal.swagger.json`:

```bash
curl https://portal-ff.dev.aur.lu/api/v1/docs/swagger.json -o packages/aurora-portal-client/aurora-portal.swagger.json && oxfmt
```

Reformat the file:

```bash
pnpm lint:fix
```

**Regenerate both clients:**

```bash
pnpm generate:api-clients
```

## UI submodule (`packages/ui`)

`packages/ui` is a git submodule pointing to `joemocode-business/ui-hyperspace` — a fork of `@filecoin-foundation/ui-filecoin` adapted for Vite/React. It is consumed from source by the website (no separate build step in dev).

**Importing components in the website**

```tsx
import { Button } from '@hyperspace/ui/Button';
import { Section } from '@hyperspace/ui/Section/Section';
import { Heading } from '@hyperspace/ui/Heading';
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

## Observability

Logs are sent to Grafana Cloud. See `docs/architectural-decisions/2026-03-observability-architecture.md` for details.

**Logs**: CloudWatch Logs → Kinesis Firehose → Grafana Cloud Loki.

### Grafana secrets

Generate API keys in Grafana Cloud (grafana.com → your stack → Connections → API keys):

- **GrafanaLokiAuth**: Plain `<instanceId>:<apiKey>` where instanceId is your Loki instance ID (sent as-is in the Firehose `X-Amz-Firehose-Access-Key` header)

```bash
# GrafanaLokiAuth uses plain text (Firehose access key)
pnpx sst secret set GrafanaLokiAuth '<instanceId>:<apiKey>' [--stage <stage>]
```

## Contracts (`contracts/`)

Foundry project for EVM smart contracts.

**Prerequisites** — install Foundry if you haven't already:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

### Install / Update Dependencies

```bash
forge install                             # install from foundry.lock
forge update                              # update all dependencies
forge update contracts/lib/forge-std      # update a specific dependency
```

### Build

```bash
forge build
```

### Test

```bash
forge test
```

### Format

```bash
forge fmt
```

### Gas Snapshots

```bash
forge snapshot
```

### Anvil (local node)

```bash
anvil
```

### Deploy

```bash
forge script contracts/script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```
