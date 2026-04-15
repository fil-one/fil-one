# ADR: Auto-deploy to production after staging validation

**Status:** Accepted
**Date:** 2026-04-15

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

A new smoke test suite lives under `tests/e2e/smoke/` and runs in Playwright as a dedicated `smoke` project (Chromium only, for fast local runs and ad-hoc preview validation). The pre-existing cross-browser E2E tests moved to `tests/e2e/full/` and run as `full-chromium` / `full-firefox` / `full-webkit` projects — those projects target the full `tests/e2e` tree, so the smoke tests are re-run cross-browser inside the `e2e` CI job.

The smoke suite verifies deploy-wiring concerns that unit and integration tests miss: DNS, CloudFront, Lambda wiring, and the Auth0 configuration of the deployed stage. It covers:

- **HTTP shell**: `GET /` returns the SPA `index.html` with the `<title>Fil One</title>` marker (via Playwright's `request` fixture — no browser, keeps the assertion fast and deterministic).
- **Auth wiring**: navigating to `/login` lands on the Auth0 tenant configured for the current stage. The expected tenant domain is derived from `getAuth0Domain(STAGE)` in `@filone/shared`, which is the same helper `sst.config.ts` uses — so the smoke suite and the deployment cannot drift.

In CI, the smoke specs run as part of the cross-browser `e2e` job (no separate `smoke` job). For local iteration or preview/dev validation, `pnpm test:e2e:smoke` runs just the smoke specs against Chromium.

## Consequences

- **Shorter lead time** between merge and production. A change that clears staging tests reaches production without waiting on a human to click merge.
- **No manual gate.** The staging test suite (unit + smoke + integration + E2E) is the only safety net. Coverage gaps in those suites become production risks, so broken tests must be fixed promptly rather than skipped.
- **Production branch gone.** Branch-protection rules and workflow triggers referencing `production` are removed. The `production` GitHub environment remains — it still holds the AWS OIDC role ARN and other environment-scoped variables used by the `deploy-production` job.
- **Smoke tests as a new contract.** The smoke suite must stay fast and narrow (no auth-gated endpoints, no flaky assertions) so it's a reliable pre-production signal rather than a source of false alarms. When run via `pnpm test:e2e:smoke` locally or against a preview, it's Chromium-only; cross-browser coverage comes from the `full` projects in CI.
- **Rollback via revert.** There is no separate "deploy this tag to production" workflow. A bad deploy is rolled back by reverting the offending commit on `main` and letting the pipeline re-deploy.
