# Bucket policy e2e suite

End-to-end tests for bucket policies (ADR #696, fil-one/RFC#30). They run against a local stage whose `us-east-9` region uses the `iam` access model, backed by a smelt network. They never run against staging: the `full-*` projects ignore this directory.

## What they need

- **smelt**, running Hilt, Ingot and Swarf from source. Run `SMELT_WORKSPACE=1` with `hilt`, `ingot` and `swarf` in `go.work`, and `INGOT_REGION=us-east-9`. Ingot's config must allow `https://localhost:5173` as a CORS origin.
- **The console**, deployed to floci with `SMELT=true pnpm deploy:local`, with `getRegionAccessModel` returning `'iam'` for `us-east-9`. Serve it with `pnpm --filter @filone/website dev`.
- **Two Auth0 dev-tenant accounts**, an Owner and a Member, in `.env.e2e.local`. That file is gitignored and `playwright.config.ts` loads it. Create the accounts once:

  ```bash
  node bin/e2e-register-policy-users.ts signup https://localhost:5173
  node bin/e2e-register-policy-users.ts verify '<link from the verification email>'   # once per account
  node bin/e2e-register-policy-users.ts finish https://localhost:5173
  ```

## Running

```bash
unset AWS_PROFILE
eval "$(floci env)"
export AWS_REGION=us-east-1 LOCAL=true BASE_URL=https://localhost:5173
pnpm exec sst shell --stage local -- pnpm exec playwright test --project=policies-local
```

`policies-setup` logs both accounts in and claims and activates the Owner's subscription. It then seats the Member in the Owner's organization.

## Determinism

Every case creates its own buckets and keys and deletes them afterwards. Uploads use a fixed in-memory payload.

A narrowed policy only reaches a key Ingot has cached once the revocation arrives. So every check after a narrowing uses a key minted after the write, which Ingot evaluates fresh. The one exception is case 7 in `policies.spec.ts`, which watches that revocation arrive on a cached key. It is the only poll in the suite, capped at 30 seconds.
