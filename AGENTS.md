# AGENTS.md — Guidance for engineers and AI agents

## What this repo is

FilOne is the central customer-facing plane of the Fil One storage product: sign-up, authentication, org/tenant management, bucket and access-key UX, usage metering, billing, and monitoring. It does **not** store customer objects itself — actual storage is provided by external **Service Orchestrators** (currently Aurora in the EU and FTH/Fortilyx in the US) that FilOne drives over HTTP.

It is a **pure AWS / Auth0 / Stripe / SendGrid TypeScript stack**. There is no cryptographic identity layer here: no UCAN, DID, ed25519, delegation, or "space" concept, and no `@storacha/*` / `@ucanto/*` / `multiformats` dependencies. If a feature needs key custody or content addressing, it belongs in a provider's stack, not in this repo.

The README is the operational runbook (AWS SSO setup, SST secrets, Auth0/Stripe/SendGrid configuration, deploy and troubleshooting steps). Read it first; this file covers architecture, conventions, and gotchas the README doesn't.

## Stack and layout

- pnpm workspaces monorepo, TypeScript ESM, Node >= 24, `packageManager: pnpm@10.x`.
- Infrastructure as code via **SST v4** (Pulumi-based, despite the README calling it v3): the root `sst.config.ts` defines the per-stage app stack (API routes, tables, queues, crons, website); `infra/sst.config.ts` defines persistent per-account base infra (OIDC provider, IAM roles, metric streams).
- Lambdas are bundled with esbuild by SST. There is **no VPC** — every Lambda is non-VPC, and critical-path routes buy provisioned concurrency to fight cold starts instead.

```
sst.config.ts        # App stack. Includes the addRoute() helper that wires every API route
infra/               # Base infra stack (deployed separately: pnpm deploy:infra:*)
contracts/           # Foundry smart contracts (separate toolchain: forge build/test)
bin/                 # Operator scripts (reset-db, extend-trial, tail-logs, stale-stage cleanup)
docs/                # ADRs, Auth0/Stripe setup runbooks, service-orchestrator integration spec
tests/
  e2e/               # Playwright against a deployed stage
  integration/       # vitest against real AWS/Stripe resources, run inside `sst shell`
  s3compat/          # S3 compatibility checks
packages/
  shared/                    # Types shared between backend and website
  backend/                   # Lambda handlers, jobs, middleware, lib
  website/                   # Vite + React 19 + TanStack Router SPA + Tailwind v4 + Storybook
  rag-shared/                # RAG pipeline library (extract/chunk/embed/vector store)
  aurora-backoffice-client/  # Generated (Hey API) client for Aurora Back Office API
  aurora-portal-client/      # Generated (Hey API) client for Aurora Portal API
  oxlint-rules/              # Local lint rules
```

Backend internals (`packages/backend/src/`):

- `handlers/` — one file per API route (e.g. `create-bucket.ts`, `stripe-webhook.ts`), with a colocated `.test.ts`.
- `jobs/` — cron/queue workers: `usage-reporting-orchestrator/worker`, `rag-indexer-orchestrator/worker`, `grace-period-enforcer`, `subscription-drift-checker`, plus deploy-time `stack-setup/`.
- `middleware/` — middy middlewares: `auth`, `csrf`, `require-mfa`, `subscription-guard`, `error-handler`. Routes opt in via `addRoute()` options in `sst.config.ts`.
- `lib/` — shared logic: DynamoDB records, Stripe client, S3 client/presigner, Auth0 management, and the service-orchestrator abstraction (see below).

## Service Orchestrator abstraction (the main extension point)

- `packages/backend/src/lib/service-orchestrator.ts` defines the `ServiceOrchestrator` interface: tenant lifecycle (`ensureTenantReady`, `isTenantReady`), bucket CRUD, access-key issuance, and usage metrics.
- Implementations live in `lib/aurora/` and `lib/fth/`; `lib/service-orchestrator-registry.ts` maps a storage region to an orchestrator. The registry is **region-keyed with one instance per region** — there is no routing across multiple providers within a region.
- Adding a storage provider = implement the interface, register it for a region, and have the provider expose the Management API contract in `docs/service-orchestrator-integration/management-openapi.yaml` (tenant CRUD, access keys, status, metrics) plus an S3-compatible gateway. No rewrite of FilOne is needed. `docs/service-orchestrator-integration/README.md` describes the full integration requirements.
- `ensureTenantReady` has side effects (provider API calls, DynamoDB writes, setup-state transitions) — only call it from write paths or jobs. Read paths must use `getOrgProfile` + `isTenantReady`.

## Data and secrets model

- **DynamoDB only.** The app's state lives in `BillingTable` and `UserInfoTable` (single-table style records in `lib/dynamo-records.ts`). There is no SQL database, no RDS/Postgres, no ORM or migration tooling anywhere in the repo.
- **Naming trap:** "Aurora" throughout this codebase is the **external storage provider** (bucket orchestrator at aur.lu, accessed via the generated REST clients) — it is *not* AWS Aurora. Do not add AWS RDS/Aurora resources on the assumption that they already exist.
- S3 access keys are minted at the provider; the secret is returned once to the browser and only metadata is persisted to DynamoDB (`AccessKeyRecord` has no secret field). Per-tenant S3 keys used by the backend/console live in SSM SecureString under `/filone/<stage>/<orchestrator>-s3/access-key/<tenantId>`; other runtime secrets follow the `/filone/<stage>/...` SSM convention or are SST secrets (`sst secret set ...` — full list in the README).
- Usage/billing flow: the usage-reporting orchestrator cron fans out per-tenant work to workers, which poll provider usage APIs and push to Stripe meters; billing state (subscription status, trials, grace periods) is enforced from DynamoDB, with Stripe webhooks (`handlers/stripe-webhook.ts`) driving transitions.

## RAG pipeline

`packages/rag-shared/` implements document extraction (PDF via Textract, OOXML, HTML), chunking, embedding via **Amazon Bedrock**, and vector storage in **Amazon S3 Vectors** (`s3-vectors-store.ts`) — all VPC-less AWS services, consistent with the no-VPC rule. Indexing runs through the `rag-indexer-orchestrator` → `rag-indexer-worker` jobs in the backend; per-bucket enablement is in `lib/bucket-rag-enablement.ts` and the `*-bucket-rag-enablement` handlers, with querying via `handlers/query-bucket.ts`. Routes needing RAG resources opt in via `addRoute({ rag: true })`.

## Build, test, lint

```bash
pnpm install                 # after: git submodule update --init --recursive
pnpm run dev                 # SST live dev mode
pnpm run build               # build all packages
pnpm run lint / lint:fix     # oxlint + oxfmt (typecheck via oxlint-tsgolint)
pnpm test                    # lint + unit tests (vitest) across shared, rag-shared, backend, website
pnpm test:integration        # vitest inside `sst shell` against a deployed stage
pnpm test:e2e                # Playwright inside `sst shell` (env vars: see README)
pnpm deploy:dev              # personal stage (OS username) at https://<username>.dev.fil.one
```

- Unit tests are vitest, colocated as `*.test.ts` next to the source. Backend runs with coverage.
- Integration and E2E tests need a deployed stage and real AWS/Stripe/Auth0 resources; they run under `sst shell` so SST resource bindings resolve.
- Husky + lint-staged run oxlint/oxfmt on commit. `pnpm exec sst install` is auto-run by `prelint` if the SST platform types are missing.
- `contracts/` uses Foundry (`forge build/test/fmt`), independent of the pnpm toolchain.

## Gotchas

- **Never deploy staging or production manually** — CI/CD only (`deploy:staging` / `deploy:production` are for the pipeline).
- Stage names must be valid DNS labels (lowercase a–z, 0–9, hyphen; ≤ 63 chars) because each stage gets a `*.dev.fil.one` record.
- The deploy-time `setup-integrations` Lambda (CloudFormation custom resource) configures Auth0 and Stripe webhooks on each deploy. If it fails, the stack wedges in `UPDATE_ROLLBACK_FAILED` — the README's troubleshooting section has the `continue-update-rollback --resources-to-skip Setup` recovery.
- Two Auth0 M2M apps per tenant with different scopes (deploy-time vs runtime) — don't merge them; the split limits credential blast radius.
- `tests/e2e/.auth/` session files are regenerated per run and must never be committed.
- When adding an API route, go through the `addRoute()` helper in `sst.config.ts` (path, handler, middleware flags, provisioned concurrency) rather than wiring a raw route.
- After Aurora API changes, update the Swagger JSON in the client package and run `pnpm generate:api-clients` — never hand-edit generated client code.
