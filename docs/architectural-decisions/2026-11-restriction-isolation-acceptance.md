# Restriction isolation acceptance — sc-453

The opt-in `tests/e2e/destructive/restriction-isolation.spec.ts` compares existing
presigned GET URLs from two explicitly designated disposable staging
Organizations. It activates only the existing `disabled` test identity, writes
synthetic content only in that target, then restores its disabled resting state
in `finally`, including after partial helper failure. It never changes the
control's billing, tenant status, objects or memberships.

Set `E2E_RESTRICTION_CONTROL_FIXTURE` to a local JSON fixture with `disposable: true`,
`targetUserId`, `targetOrganizationId`, `controlUserId`, `controlOrganizationId`,
`controlStorageState`, and `objects`. The target must match `E2E_DISABLED_USER_ID`.
The control must be a separate existing disposable identity outside all four
suite roles, with a normal authenticated Playwright storage-state file. Each
`objects` entry, keyed by `eu-west-1` and `us-east-1`, names an existing `bucket`,
`key` and expected content `sha256`. Provision those harmless control objects
separately; this proof only reads them. Do not commit authentication state or
fixture identifiers. Missing configuration skips this opt-in case, never proves
restriction isolation.

The test requires the SST-bound stage to be exactly `staging`, verifies the
target's authoritative home Organization, checks distinct provisioned Aurora/FTH
tenant mappings with strong point reads, and verifies both signed-in
identities/active Organizations before changing state. Its target upload uses
a unique synthetic key and never overwrites an existing object. Both Organizations' URLs
must serve the expected content before restriction; the same target URLs must
then return 403 while still unexpired, while the same control URLs still return
200 with the expected content. The helper must report successful Aurora and FTH
status outcomes. Expiry is checked after each response, so an expired URL cannot
pass as enforcement. Ordinary staging SST access, helper invocation permission,
the disposable target's normal credentials and seeded buckets are required.

Run one browser and one worker against the reviewed staging stack:

```sh
BASE_URL='<reviewed staging console>' pnpm exec sst shell --stage staging -- \
  pnpm exec playwright test \
  tests/e2e/destructive/restriction-isolation.spec.ts \
  --project=destructive-chromium --workers=1
```

The aggregate attachment reports management-call duration and the observed time
to a denied read measured from the start of that call. Polling allows up to 60
seconds after management completion. This measures an observed upper bound,
not immediate cutoff. It retains no Organization/user IDs, signed URLs, object
keys, response contents or credentials. If restoration fails, the test fails;
recover only the exact disposable target before another run.

Scope remains Aurora and FTH. Existing `tenant-disable.spec.ts` explicitly skips
old-URL enforcement for Forge `eu-central-3` and `us-east-9` (FIL-1613). Forge's
platform adapter delegates status changes to Hilt's Service Orchestrator
Management API; the contract requires S3 gateway enforcement. Neither a 204
management response nor console refusal to mint another URL proves that an old
URL is blocked by the gateway. Remove those skips only after provider
implementation and a live designated-fixture proof. Detection, lifecycle
delivery and the integrated operator workflow remain separate acceptance gates.

No live restriction, provider change or end-to-end pass is claimed by these
offline fixtures and unit tests.
