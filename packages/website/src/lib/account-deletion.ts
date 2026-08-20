/**
 * Self-serve deletion is withheld until Aurora exposes a tenant DELETE
 * (FIL-919): its tenants are only disabled, so an org's buckets and objects
 * survive the teardown. Keep in step with ACCOUNT_DELETION_ENABLED in
 * sst.config.ts — the routes answer 501 while this is false.
 */
export const ACCOUNT_DELETION_ENABLED = false;
