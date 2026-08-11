# ADR: The SUB# tombstone permanently bans social-login identities

**Status:** Proposed — awaiting product sign-off
**Created:** 2026-08-10

> **This ADR changes no behaviour.** Nothing in it has been implemented. It records a defect found
> while reviewing the FIL-112 account-deletion stack, the fix we recommend, and the reason the fix
> was deliberately deferred rather than shipped inside that stack. The code today behaves exactly as
> described under "Context".

## Context

Account deletion (FIL-112) leaves a permanent tombstone on the deleted user's identity row:

- `UserInfoTable`, `pk: SUB#{sub}`, `sk: IDENTITY`, `deleted: true` + `deletedAt`.
- Written twice, both times with `if_not_exists(deletedAt, :now)` so the timestamp is stable across
  re-runs: once at confirm time by `applyDeletionGuards`'s member loop (`lib/deletion-guards.ts`), which is what
  kills live sessions synchronously, and once by the worker's purge
  (the SUB# update in `purgeRecords`, `lib/account-deletion.ts`), which additionally `REMOVE`s the PII-adjacent attributes
  (`userId`, `orgId`, `emailEntitlementClaimed`, `createdAt`) — the row survives stripped rather
  than being deleted.
- The row carries no `ttl` attribute, so DynamoDB never expires it.

Three call sites read it:

| Site                            | Behaviour on `deleted === true`                                           |
| ------------------------------- | ------------------------------------------------------------------------- |
| `middleware/auth.ts:232-233`    | Throws `AccountDeletedError` → 410 `ACCOUNT_DELETED` with cleared cookies |
| `handlers/auth-callback.ts:139` | Never mints cookies; redirects to the static `/account-deleted` page      |
| `lib/identity-tombstone.ts`     | Strongly-consistent post-write verification for billing writers           |

The tombstone exists for a good reason. It is the only thing that stops a stale-but-still-valid
access token — or an Auth0 SSO session that silently re-authenticates — from walking back through
`resolveIdentity` and falling into `createNewUserAndOrg`, resurrecting an account the teardown has
just dismantled. Deleting the row instead of tombstoning it would reopen exactly that hole.

### Nothing ever clears it

Verified by grep across the whole FIL-112 stack (`git grep -nE "REMOVE deleted|deleted = |:deleted"`
over `packages/backend/src/**/*.ts`): `deleted` appears in exactly two write expressions, both
`SET deleted = :true`. There is no code path anywhere — no handler, no job, no admin script — that
removes the attribute, sets it to `false`, or deletes the row. Combined with the absent `ttl`, the
tombstone is unconditionally permanent.

### Why that is a problem only for social logins

An Auth0 `sub` is `{connection}|{provider-user-id}`. Whether the provider-user-id is stable across a
delete-and-signup cycle depends entirely on the connection type:

- **Database connection (`auth0|…`).** Auth0 mints a fresh random id on every signup. Deleting the
  Auth0 user and signing up again with the same email produces a **different** sub, which has no
  tombstone. The user gets a clean account.
- **Social connection (`google-oauth2|…`, `github|…` — see
  `packages/shared/src/connection-providers.ts`).** The provider-user-id is the Google/GitHub account
  id, which is stable forever and is not ours to change. Deleting the Auth0 user and signing in
  again with the same Google account mints the **same** sub.

So for a social-login user, the teardown's own deletion of the Auth0 user does not help. The next
sign-in reproduces the tombstoned sub, `auth-callback` redirects to `/account-deleted`, and
`middleware/auth.ts` refuses every API call with `ACCOUNT_DELETED`. There is no self-service escape
and no operator runbook for one.

**This does not show up in manual testing**, which is why it survived review of the feature itself:
test accounts are overwhelmingly database connections, and those behave correctly.

### Two consequences worth stating plainly

1. **A GDPR-motivated deletion becomes an irreversible ban on that identity.** The user exercised a
   right to erasure and, as a side effect, lost the ability to ever be a customer again under their
   Google or GitHub identity. That is not what "delete my account" promises, and the permanence is
   not disclosed anywhere in the flow.
2. **Trial-abuse prevention does not need it.** That job is already done, independently and
   deliberately, by the `EMAIL_NORM#{normalizedEmail}` claim record (`lib/trial-entitlement.ts:72`),
   which is retained by design (FIL-422) and survives account deletion. A returning user who signs
   up again gets an account with **no trial**, which is the intended outcome. The SUB# tombstone adds
   nothing here; it only converts "no trial" into "no account".

## Decision

**Recommended, not implemented:** scope the tombstone to what it actually needs to defend against,
which is the lifetime of tokens minted before the deletion — not eternity.

Treat `deleted === true` as terminal **only when the presented token predates the deletion**:

```
tombstoned AND token.iat (or auth_time) < deletedAt   →  reject, as today
tombstoned AND token.iat (or auth_time) >= deletedAt  →  pass through to createNewUserAndOrg
```

The soundness argument is that the teardown deletes the Auth0 user. A token whose `iat` postdates
`deletedAt` therefore cannot have been issued to the old Auth0 user — it can only come from a fresh
Auth0 signup that happened to land on the same social sub. That is a new person-shaped event, not a
resurrection, and the resurrection defence loses nothing by admitting it. `auth_time` is the
stricter of the two claims (it reflects when the user actually authenticated rather than when the
token was refreshed) and is preferable where Auth0 asserts it.

Both readers would need the change, not just one: `middleware/auth.ts` for API calls and
`handlers/auth-callback.ts` for the login redirect, or the user is admitted by one and bounced by the
other.

**`createNewUserAndOrg` must be adjusted in the same change.** Its SUB# `Put` carries
`ConditionExpression: 'attribute_not_exists(pk)'` (`middleware/auth.ts:320`), which exists precisely
to make resurrection fail even if the read-side gate is bypassed. A legitimate post-`deletedAt`
signup arrives at a partition key that _does_ exist — the tombstone — so the transaction would fail
with a `ConditionalCheckFailedException` and the user would see a 500 instead of an account. The
condition has to be widened to something like `attribute_not_exists(pk) OR deleted = :true`, so that
the only pre-existing row it will overwrite is a tombstone, never a live identity. Note that this
makes the Put an overwrite, so the write must reconstruct the full row rather than relying on the
remaining tombstone attributes, and `deletedAt` must be cleared as part of it.

### Trade-offs

- **Cost of doing this:** a narrow, previously-impossible window opens. If Auth0 user deletion were
  to fail while the DynamoDB teardown succeeded, a token refreshed after `deletedAt` for the _old_
  Auth0 user would now be admitted. Using `auth_time` rather than `iat` closes most of it — a token
  refresh does not advance `auth_time`, so only a _fresh interactive authentication_ against a
  surviving Auth0 user could slip through. This should be weighed explicitly rather than waved
  through.
- **Cost of not doing this:** the permanent ban stands, silently, for every social-login user who
  deletes their account. It is invisible until a support ticket arrives, and at that point there is
  no remediation short of a manual DynamoDB edit.
- **Cheaper alternative considered:** disclose the permanence in the deletion UI ("you will not be
  able to sign in with this Google account again"). This is honest but keeps a user-hostile
  behaviour, and does not help the user who already deleted.
- **Why it was deferred:** the fix touches the authentication path's resurrection defence — the one
  mechanism the rest of the FIL-112 stack is built on top of — and it changes a user-visible
  promise. Both warrant product sign-off and a review cycle of their own rather than being folded
  into a remediation batch.

## Open questions

- **Product sign-off on permanent social-identity lockout.** If product accepts the current
  behaviour as intended, this ADR should be re-filed as Accepted with the disclosure-in-UI mitigation
  above; if not, the `iat`/`auth_time` fix should be scheduled. Either way the status quo — permanent
  and undisclosed — should not simply persist by default.
- **The `customer.deleted` webhook has no recovery window.** Related deferred item, tracked in
  `FIL-112-REVIEW-FINDINGS.md` §4.3: a `customer.deleted` event from Stripe currently triggers the
  full, irreversible teardown immediately. A drafted mitigation is to write the DELETION record and
  arm the fences synchronously — so the account is inert from the moment the event lands and nothing
  can be written against it — but to **defer the worker invoke by ~24 h**, leaving a day in which a
  mistaken or malicious deletion can be reverted before any tenant, secret or Stripe object is
  actually destroyed. That mitigation interacts with this ADR: a deletion that is reverted inside the
  window must also clear the SUB# tombstone, which today nothing can do.

## References

Symbols rather than line numbers, so these stay accurate as the files move.

- Tombstone writers: `applyDeletionGuards`'s member loop
  (`packages/backend/src/lib/deletion-guards.ts`) and the SUB# update in `purgeRecords`
  (`packages/backend/src/lib/account-deletion.ts`)
- Tombstone readers: `packages/backend/src/middleware/auth.ts`,
  `packages/backend/src/handlers/auth-callback.ts`,
  `packages/backend/src/lib/identity-tombstone.ts`
- Resurrection condition: `resolveUserAndOrg` in `packages/backend/src/middleware/auth.ts`
- Connection-type metadata: `packages/shared/src/connection-providers.ts`
- Trial claim record (the actual abuse control): `packages/backend/src/lib/trial-entitlement.ts:72`
- [Tenant deletion semantics ADR](2026-08-tenant-deletion-semantics.md)
