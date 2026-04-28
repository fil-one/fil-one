# ADR: Auto-deploy to production after staging validation

**Status:** Accepted
**Date:** 2026-04-28

## Context

The previous release flow required a human to open a PR from `main` → `production` and merge it to trigger a production deploy. This added latency between "code is known-good on staging" and "code is in production", and created drift whenever the PR sat un-merged. The `production` branch became a secondary source of truth that had to be kept in sync manually.

Staging deploys are already automated: every push to `main` deploys to staging and runs integration + E2E tests against `https://staging.fil.one`. If those tests pass, the code is already validated against the same infrastructure-as-code (SST) that production uses — the only remaining signal a human gave by merging the production PR was "I saw the staging tests pass."

## Decision

Chain the production deploy directly onto a green `test-staging` run. The new pipeline is a single linear graph:

```
push to main
  → check-packages (lint/build/unit)
  → deploy-staging
  → test-staging (smoke + integration + E2E)
  → deploy-production
```

Each step gates the next. If any step fails, the pipeline stops and alerts `#filone-alerts`. No human approval is required between staging validation and production deploy.

The `production` branch is removed. Rollback is by `git revert` on `main`; the pipeline re-deploys the reverted state.

### Test suite layout

The E2E suite under `tests/e2e/` is split in two:

- `tests/e2e/smoke/` — **non-destructive** checks that are safe to run against any deployment, including production.
- `tests/e2e/destructive/` — flows that mutate shared state (re-seeding `BillingTable` rows, exercising authenticated dashboard interactions). For safety, we only run them against non-production environments.

Playwright exposes both as projects. `full-chromium` / `full-firefox` / `full-webkit` walk the entire `tests/e2e` tree (smoke + destructive) cross-browser, depend on the `setup` project for authenticated storage state, and need DynamoDB access so `auth.setup.ts` can re-seed `BillingTable` — they require the `pnpm exec sst shell` wrapper. The `smoke` project (Chromium only) does not touch SST-bound resources, so it runs outside `sst shell` and only needs `BASE_URL` to be set. `pnpm test:e2e` runs every project under `sst shell` (and is what `test-staging` invokes); `pnpm test:smoke` runs only the smoke project and is the entry point for production and preview validation.

The smoke suite verifies deploy-wiring concerns that unit and integration tests miss: DNS, CloudFront, Lambda wiring, and the Auth0 configuration of the deployed stage. It covers:

- **HTTP shell**: `GET /` returns the SPA `index.html` with the `<title>Fil One</title>` marker (via Playwright's `request` fixture — no browser, keeps the assertion fast and deterministic).
- **Auth wiring**: navigating to `/login` lands on the Auth0 tenant configured for the current stage. The expected tenant is derived from `BASE_URL` alone — `getStageFromHostname()` maps the hostname back to a stage and `getAuth0Domain()` maps that stage to the tenant, both in `@filone/shared` and both also used by `sst.config.ts` (and by the website's own `FILONE_STAGE` inference). The smoke suite and the deployment therefore cannot drift on the Auth0 binding, and the suite needs no `STAGE` env var alongside `BASE_URL`.

### Testing production deployments

We deliberately keep the destructive suite away from production. We have the following two layers of verification:

1. **Staging as a proxy.** The cross-browser `full-*` run in `test-staging` exercises the same code on the same SST infrastructure that production uses. A green run there is the precondition for `deploy-production`.
2. **Smoke against production.** The `smoke` project is non-destructive by design, so it can be pointed at `https://app.fil.one` to confirm the production stage actually serves traffic and is wired to the production Auth0 tenant.

## Consequences

- **Shorter lead time** between merge and production. A change that clears staging tests reaches production without waiting on a human to click merge.
- **No manual gate.** The staging test suite (unit + smoke + integration + E2E) is the only safety net. Coverage gaps in those suites become production risks, so broken tests must be fixed promptly rather than skipped.
- **Production branch gone.** Branch-protection rules and workflow triggers referencing `production` are removed. The `production` GitHub environment remains — it still holds the AWS OIDC role ARN and other environment-scoped variables used by the `deploy-production` job.
- **Smoke tests as a new contract.** The smoke suite must stay non-destructive so we can run it safely against production. `pnpm test:smoke` (Chromium only, no `sst shell` needed) is the standalone entry point; cross-browser coverage of the same specs comes from the `full-*` projects in `test-staging`.
- **Rollback via revert.** There is no separate "deploy this tag to production" workflow. A bad deploy is rolled back by reverting the offending commit on `main` and letting the pipeline re-deploy.
