# Bucket policy e2e suite

End-to-end tests for bucket policies (ADR #696, fil-one/RFC#30). They run against a local stage whose `us-east-9` region uses the `iam` access model, backed by a smelt network. They never run against staging: the `full-*` projects ignore this directory.

## What they need

- **smelt**, running Hilt, Ingot and Swarf from source. Run `SMELT_WORKSPACE=1` with `hilt`, `ingot` and `swarf` in `go.work`, and `INGOT_REGION=us-east-9`. Hilt must be at fil-forge/hilt#89 and Ingot at fil-forge/ingot#194 or later: the console writes policies through `PutBucketPolicy`, which reach Hilt as `/s3/bucket/policy`. Ingot's config must allow `https://localhost:5173` as a CORS origin.
- **The console**, deployed to floci with `SMELT=true pnpm deploy:local`, with `getRegionAccessModel` returning `'iam'` for `us-east-9`. Serve it with `pnpm --filter @filone/website dev`.
- **Five Auth0 dev-tenant accounts** in `.env.e2e.local`: an Owner, an Admin, a Member, a ReadOnly user, and a Leaver (a second Member that only the removal case uses). That file is gitignored and `playwright.config.ts` loads it. Create the accounts once:

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

`policies-setup` logs all five accounts in and claims and activates the Owner's subscription. It then seats the other four in the Owner's organization: the Admin, the Member, the ReadOnly user, and the Leaver as a Member.

## Determinism

Every case creates its own buckets and keys and deletes them afterwards. Uploads use a fixed in-memory payload.

A narrowed policy only reaches a key Ingot has cached once the revocation arrives. So every check after a narrowing uses a key minted after the write, which Ingot evaluates fresh. The suite polls in two places, each capped at 30 seconds, because a cached key is their subject: case 7 in `policies.spec.ts` watches a narrowing's revocation arrive, and A6 in `policy-enforcement.spec.ts` watches a widened grant arrive.
