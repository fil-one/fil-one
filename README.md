# Fil One

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
pnpx sst secret set Auth0MgmtRuntimeClientId <value> [--stage <stage>]
pnpx sst secret set Auth0MgmtRuntimeClientSecret <value> [--stage <stage>]
pnpx sst secret set StripeSecretKey <value> [--stage <stage>]
pnpx sst secret set StripePriceId <value> [--stage <stage>]
pnpx sst secret set AuroraBackofficeToken <value> [--stage <stage>]
pnpx sst secret set SendGridApiKey <value> [--stage <stage>]
pnpx sst secret set GrafanaLokiAuth '<instanceId>:<apiKey>' [--stage <stage>]
```

Omit `--stage` to set for your personal dev stage (defaults to OS username).

There are two Auth0 M2M credentials with different scopes — see the [Auth0 M2M Setup](#auth0-machine-to-machine-m2m-application) section below. The `AuroraBackofficeToken` is from the Aurora Back Office dashboard — see the [API token](#api-token) section below. The `GrafanaLokiAuth` secret is from Grafana Cloud — see the [Observability](#observability) section below.

## Commands

```bash
pnpm run dev              # SST live dev mode (live Lambda debugging)
pnpm run build            # Build all packages
pnpm run deploy:dev       # Build and deploy personal dev stack (uses OS username as stage)
pnpm run remove           # Remove your personal dev stack
pnpm run storybook        # Start Storybook dev server on port 6006
pnpm run test:storybook   # Run Storybook tests (browser-based, requires Playwright)
pnpm run lint             # Lint and typecheck TypeScript code (via oxlint)
pnpm run lint:fix         # Lint and auto-fix where possible
```

> **Do not run `deploy:staging` or `deploy:production` manually.** Staging and production deployments should go through CI/CD.

```bash
# Local website dev server (for frontend-only changes)
cd packages/website && pnpm run dev
```

### E2E Tests

Playwright end-to-end test suite under `tests/e2e/` that runs against a deployed environment (typically staging). The `@playwright/test` package is already a devDependency, so `pnpm install` covers it.

**Install browser binaries** (one-time):

```bash
pnpm exec playwright install --with-deps
```

#### Required env vars

| Variable                                                          | Purpose                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `BASE_URL`                                                        | The deployed app URL (e.g. `https://staging.fil.one`) |
| `E2E_PAID_EMAIL` / `E2E_PAID_PASSWORD` / `E2E_PAID_USER_ID`       | Paid test user (Auth0 sub goes in `_USER_ID`)         |
| `E2E_UNPAID_EMAIL` / `E2E_UNPAID_PASSWORD` / `E2E_UNPAID_USER_ID` | Unpaid test user                                      |
| `E2E_TRIAL_EMAIL` / `E2E_TRIAL_PASSWORD` / `E2E_TRIAL_USER_ID`    | Trial test user                                       |

In CI, all nine credential vars come from GitHub repository secrets (see [.github/workflows/e2e-staging.yaml](.github/workflows/e2e-staging.yaml) and [.github/workflows/test-staging.yaml](.github/workflows/test-staging.yaml)). Both workflows also configure AWS via OIDC (using `vars.AWS_ROLE_ARN`) so the billing-state reset can write to the staging `BillingTable`.

#### Running locally

The `test:e2e` script wraps Playwright in `sst shell` so SST Resource bindings (e.g. `BillingTable` name) resolve to the current SST stage. Deploy a stage first, then:

```bash
SST_STAGE=staging \
BASE_URL=https://staging.fil.one \
E2E_PAID_EMAIL=...   E2E_PAID_PASSWORD=...   E2E_PAID_USER_ID=auth0|... \
E2E_UNPAID_EMAIL=... E2E_UNPAID_PASSWORD=... E2E_UNPAID_USER_ID=auth0|... \
E2E_TRIAL_EMAIL=...  E2E_TRIAL_PASSWORD=...  E2E_TRIAL_USER_ID=auth0|... \
pnpm test:e2e --project=chromium
```

Your local AWS credentials (e.g. via `aws sso login`) must have write access to the staging stage's `BillingTable`.

After a run, an HTML report is generated at `playwright-report/`. To view it:

```bash
pnpm exec playwright show-report
```

> CI runs these tests automatically against preview deployments on PRs.

#### Subscription state reset

[tests/e2e/auth.setup.ts](tests/e2e/auth.setup.ts) re-seeds the `BillingTable` row for each role before logging that role in. This is necessary because trial periods can elapse and `past_due` subscriptions can advance to `canceled` between scheduled runs, so prior runs' state is not safe to reuse.

The seed values come from [tests/e2e/billing-reset.ts](tests/e2e/billing-reset.ts):

- **paid** → `active`, `currentPeriodEnd` = now + 30d
- **unpaid** → `past_due`, `lastPaymentFailedAt` = yesterday
- **trial** → `trialing`, `trialEndsAt` = now + 14d

The reset writes directly to DynamoDB (mirrors the integration-test pattern in [tests/integration/helpers.ts](tests/integration/helpers.ts)). It does **not** sync with Stripe — the local DB is the source of truth for `subscriptionStatus`, and Stripe state is allowed to drift for these test users.

#### How auth works

Each role logs in once via [tests/e2e/auth.setup.ts](tests/e2e/auth.setup.ts) and the session cookies are persisted to `.auth/<role>.json`. Authenticated specs reuse that storage state instead of going through the Auth0 login UI on every test.

The `.auth/` directory is gitignored — the JSON files are regenerated on every run and **must not be committed**.

#### Adding a new role

1. Add an entry to [tests/e2e/roles.ts](tests/e2e/roles.ts) `STORAGE_STATE`.
2. Add the role's desired subscription state to `DESIRED_STATE` in [tests/e2e/billing-reset.ts](tests/e2e/billing-reset.ts).
3. Add the role to the `roles` array in [tests/e2e/auth.setup.ts](tests/e2e/auth.setup.ts) (with `email`, `password`, `userId`).
4. Add `E2E_<ROLE>_EMAIL`, `E2E_<ROLE>_PASSWORD`, `E2E_<ROLE>_USER_ID` to `REQUIRED_CREDENTIAL_VARS` in [playwright.config.ts](playwright.config.ts).
5. Add the same three vars to the `env:` block in both [.github/workflows/e2e-staging.yaml](.github/workflows/e2e-staging.yaml) and [.github/workflows/test-staging.yaml](.github/workflows/test-staging.yaml), and provision the corresponding GitHub secrets.

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
pnpm deploy:dev
```

Uses your OS username as the stage name. No custom domain — outputs a CloudFront URL.

If you are having trouble deploying after SST changes (e.g., a version bump of SST or drift on components from manual actions), you may need to refresh the stack:

```bash
pnpm run refresh
pnpm deploy:dev
```

### Staging / Production

> **Do not deploy to staging or production manually** unless there is a very good reason. Use CI/CD.

For reference, the CI/CD pipeline runs:

```bash
pnpm run deploy:staging
pnpm run deploy:production
```

Custom domains require a pre-provisioned ACM certificate in us-east-1 and a DNS CNAME pointing to the CloudFront distribution (managed by a separate pipeline).

Infrastructure-only deploys are available for cases where only the base infra (OIDC, IAM roles) needs updating:

```bash
pnpm run deploy:infra:staging
pnpm run deploy:infra:production
```

### Live Dev Mode

```bash
pnpx sst dev
```

Runs Lambda functions locally with live reload. Changes to handler code take effect immediately without redeploying.

### Troubleshooting: CloudFormation Stack Stuck in Rollback

The deploy-time setup Lambda (`setup-integrations`) runs as a CloudFormation custom resource. If it fails (e.g., missing Auth0 scopes, API errors), the CloudFormation stack enters `UPDATE_ROLLBACK_FAILED` state and blocks all future deploys.

**To unblock:**

1. Force the rollback to complete, skipping the failed resource:

```bash
aws cloudformation continue-update-rollback \
  --stack-name <stack-name> \
  --region us-east-2 \
  --resources-to-skip Setup
```

The stack name is in the error output (e.g., `SetupStack-efd549a`).

2. Wait for the stack to reach `UPDATE_ROLLBACK_COMPLETE`:

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --region us-east-2 \
  --query 'Stacks[0].StackStatus'
```

3. Fix the underlying issue (grant missing scopes, etc.), then redeploy.

### Troubleshooting: Auth0 Action / Login Issues

If MFA enrollment or login flows aren't working as expected, check the Auth0 logs:

1. Go to **Auth0 Dashboard > Monitoring > Logs**
2. Look for recent login events — failed logins show as type `f` (Failed Login) or `fp` (Failed Login - Password)
3. Expand the event to see:
   - `description` — the error message (e.g., Action returned invalid data)
   - `details.actions.executions` — confirms whether the Post-Login Action ran
   - `details.error.message` — the specific failure reason

Common issues:

- **"Invalid MFA command"** — the `enrollWith()` / `challengeWith()` call signature is wrong. Auth0's Action runtime expects a single object (e.g., `{ type: 'otp' }`), not an array.
- **Action not executing** — verify the Action is in the Login flow: **Actions > Triggers > Login**. Being in the Library is not enough — it must be dragged into the flow and **Apply** must be clicked.
- **`mfa_enrolling` flag not set** — check the user's `app_metadata` in **User Management > Users > (user) > app_metadata**. The backend sets this when `POST /api/mfa/enroll` is called.

## ACM Certificate Provisioning & DNS Setup

Custom domains require an ACM certificate in **us-east-1** (CloudFront requirement):

We manage this in another repo: https://github.com/FilecoinFoundationWeb/FilHyperspace-Infrastructure

Example PR To add `staging.fil.one`: https://github.com/FilecoinFoundationWeb/FilHyperspace-Infrastructure/pull/3

## Auth0

Two Auth0 tenants are used:

| Environment | Tenant        | Domain                              | Dashboard                                                                                                                      |
| ----------- | ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Staging/dev | **FilOneDev** | `dev-oar2nhqh58xf5pwf.us.auth0.com` | [Dashboard](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/hAHMVzFTsFMrtxHDfzOvQCLHgaAf3bPQ/settings) |
| Production  | **fil-one**   | `fil-one.us.auth0.com`              | [Dashboard](https://manage.auth0.com/dashboard/us/fil-one)                                                                     |

Auth0 credentials are managed as SST secrets (`Auth0ClientId`, `Auth0ClientSecret`). See the "Set SST secrets" step above.

**Callback and logout URLs are configured automatically during deploy** — no manual Dashboard edits needed. The deploy-time setup Lambda adds the correct URLs for the deployed domain (custom domain or CloudFront).

**Application settings** (Applications > your app > Settings):

- Under **Advanced Settings > Grant Types**, ensure **Authorization Code** and **Refresh Token** are enabled.

**API setup** (APIs > Create API):

- **Identifier (audience)**: `app.fil.one` (prod) — this must match `AUTH0_AUDIENCE` in `sst.config.ts`. It's what makes Auth0 issue a JWT access token (instead of an opaque one) and is the `aud` claim the middleware validates.
- Under the API's **Machine to Machine Applications** tab, authorize your application so it can exchange tokens.

### Auth0 MFA Setup

MFA is opt-in per user (database and social connections). Auth0 handles enrollment and challenge via Universal Login. See `docs/architectural-decisions/2026-03-mfa-enrollment.md` for the full architectural decision record.

Two separate M2M applications are used to limit the scope of credentials exposed to Lambda functions.

#### Deploy automation (`Auth0MgmtClientId` / `Auth0MgmtClientSecret`)

Used only by the deploy-time setup Lambda to configure Auth0 on each deploy. Not available to runtime Lambda functions.

**1. Enable MFA factors** (Security > Multi-factor Auth) — manual, one-time per tenant:

- Enable **One-time Password** (authenticator apps)
- Enable **WebAuthn with FIDO Security Keys** (passkeys/security keys)
- Enable **WebAuthn with FIDO Device Biometrics** (fingerprint, Face ID)
- Do **not** enable **Email** or **SMS** — turning Email on tenant-wide causes Auth0 to auto-enroll every verified-email user into email MFA, defeating the strong-factor-only design
- Set policy to **"Never"** (MFA is controlled entirely by the Post-Login Action)
- Under additional settings, enable **"Customize MFA Factors using Actions"**

**2. Post-Login Action** — automated on deploy:

The deploy-time setup Lambda (`setup-integrations`) automatically creates, deploys, and binds an `MFA Enrollment Trigger` Action to the Login flow (staging/production only). This Action checks `app_metadata.mfa_enrolling` on each login — when `true`, it triggers MFA enrollment via Universal Login and clears the flag after success. No manual Action setup is needed.

### Auth0 Machine-to-Machine (M2M) Applications

Two separate M2M applications per tenant limit the blast radius of credentials. The deploy-time app is only available to the setup Lambda; the runtime app is available to request-time handlers.

#### Deploy automation (`Auth0MgmtClientId` / `Auth0MgmtClientSecret`)

Used only by the deploy-time setup Lambda to configure Auth0 on each deploy.

| Environment | App name          | Dashboard                                                                                                                     |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Staging     | `SSTSetupM2MApp`  | [Settings](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/WaVEvlq7iAirQa15CPPZJX0leTKWPJgw/settings) |
| Production  | Deploy Automation | [Settings](https://manage.auth0.com/dashboard/us/fil-one/applications/8t5J60CfojuktFBqppOseY8IzYQYYrcv/settings)              |

**Required scopes** (Applications > M2M app > APIs > Auth0 Management API):

`read:clients`, `update:clients`, `read:email_provider`, `create:email_provider`, `update:email_provider`, `create:actions`, `read:actions`, `update:actions`, `read:triggers`, `update:triggers`

```bash
pnpx sst secret set Auth0MgmtClientId <M2M-client-id> [--stage <stage>]
pnpx sst secret set Auth0MgmtClientSecret <M2M-client-secret> [--stage <stage>]
```

#### Runtime user management (`Auth0MgmtRuntimeClientId` / `Auth0MgmtRuntimeClientSecret`)

Used by request-time Lambda handlers (`update-profile`, `resend-verification`, `enroll-mfa`, `disable-mfa`, `delete-mfa-enrollment`, `get-me`) to manage user records, trigger verification emails, and manage MFA enrollments.

| Environment | App name    | Dashboard                                                                                                                     |
| ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Staging     | Runtime M2M | [Settings](https://manage.auth0.com/dashboard/us/dev-oar2nhqh58xf5pwf/applications/CCONYSKqPecSTV8fxpfQJ7TLu6JseYSz/settings) |
| Production  | Runtime M2M | [Settings](https://manage.auth0.com/dashboard/us/fil-one/applications/1VydX3EOVZDHmVF3IdKa7n7pzRuczj7O/settings)              |

**Required scopes** (Applications > M2M app > APIs > Auth0 Management API):

`read:users`, `update:users`, `update:users_app_metadata`, `create:user_tickets`, `delete:users`, `delete:guardian_enrollments`, `read:authentication_methods`, `create:authentication_methods`, `delete:authentication_methods`

```bash
pnpx sst secret set Auth0MgmtRuntimeClientId <M2M-client-id> [--stage <stage>]
pnpx sst secret set Auth0MgmtRuntimeClientSecret <M2M-client-secret> [--stage <stage>]
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

Run this command to delete all webhooks created by PR preview deployments (including hooks from active pull requests):

```bash
stripe webhook_endpoints list --limit 100 | \
  jq -r '.data[] | select(.metadata.stage // "" | startswith("pr-")) | .id' | \
  xargs -I{} stripe webhook_endpoints delete {} --confirm
```

### 4. Secrets

Stripe credentials are managed as SST secrets (`StripeSecretKey`, `StripePriceId`, `StripePublishableKey`). See the "Set SST secrets" step above.

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

Telemetry is sent to Grafana Cloud. See `docs/architectural-decisions/2026-03-observability-architecture.md` for details.

**Logs**: CloudWatch Logs → Kinesis Firehose → Grafana Cloud Loki (per-stage, managed by the main stack).
**Metrics**: CloudWatch Metrics → Metric Stream → Kinesis Firehose → Grafana Cloud Prometheus (per-account, managed by the `infra/` stack — one stream captures all Lambda metrics in the account regardless of stage). Developer stacks do not stream metrics to Grafana; use the CloudWatch console instead.

### Grafana secrets

Generate API keys in Grafana Cloud (grafana.com → your stack → Connections → API keys):

- **GrafanaLokiAuth** (main stack): Plain `<instanceId>:<apiKey>` where instanceId is your Loki instance ID (sent as-is in the Firehose `X-Amz-Firehose-Access-Key` header)
- **GrafanaPrometheusAuth** (infra stack): Plain `<instanceId>:<apiKey>` where instanceId is your Prometheus instance ID

```bash
# Main stack secrets
pnpx sst secret set GrafanaLokiAuth '<instanceId>:<apiKey>' [--stage <stage>]

# Infra stack secrets (run from infra/ directory)
cd infra && pnpx sst secret set GrafanaPrometheusAuth '<instanceId>:<apiKey>' --stage <stage>
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
