# Bucket policy e2e suite

End-to-end tests for bucket policies (ADR #696, fil-one/RFC#30). They run against a stage whose Forge region serves the `iam` access model: locally `us-east-9`, backed by a smelt network; on a remote stage `eu-central-3`. The `full-*` projects ignore this directory, so the suite runs only as the `policies` project.

## What they need

- **smelt**, running Hilt, Ingot and Swarf from source. Run `SMELT_WORKSPACE=1` with `hilt`, `ingot` and `swarf` in `go.work`, and `INGOT_REGION=us-east-9`. Hilt must be at fil-forge/hilt#89 and Ingot at fil-forge/ingot#194 or later: the console writes policies through `PutBucketPolicy`, which Hilt receives as `/s3/bucket/policy`. Ingot's config must allow `https://localhost:5173` as a CORS origin.
- **The console**, deployed to floci with `SMELT=true pnpm deploy:local` and served with `pnpm --filter @filone/website dev`.
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
SST_STAGE=local pnpm test:e2e:policies
```

## Remote stage

The same suite runs against staging. Register the five accounts against the stage once (`signup`, `verify`, `finish` with `https://staging.fil.one` as the origin; `E2E_POLICY_EMAIL_PREFIX` sets their addresses and `E2E_POLICY_ENV_FILE` the file they are written to), keep their credentials in `.env.e2e.local` or the `E2E_POLICY_*` secrets, and run the project through `sst shell` so the member and billing seeds reach the stage's tables:

```bash
export AWS_REGION=us-east-2 BASE_URL=https://staging.fil.one
SST_STAGE=staging pnpm test:e2e:policies
```

`E2E_POLICY_REGION` and `E2E_POLICY_S3_ENDPOINT` override the region and the S3 endpoint; by default a remote stage uses `eu-central-3` and the endpoint `getS3Endpoint` derives for it. The staging Forge network has to run Hilt and Ingot with the policy operations. In CI, `e2e-staging.yaml` runs the project when the `E2E_POLICY_*` secrets are set.

`policies-setup` logs all five accounts in and claims and activates the Owner's subscription. It then seats the other four in the Owner's organization: the Admin, the Member, the ReadOnly user, and the Leaver as a Member.

## Determinism

Every case creates its own buckets and keys and deletes them afterwards. Uploads use a fixed in-memory payload.

A narrowed policy applies to a key Ingot has cached only once the revocation arrives. So every check after a narrowing uses a key created after the write, which Ingot evaluates fresh. Only the cached-key tests poll, each for at most 30 seconds, because a key Ingot has cached is what they check.
