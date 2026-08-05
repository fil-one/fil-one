/**
 * Deletion guard for FIL-112 account deletion: billing-record updates only apply while
 * the record exists and no deletion has been requested. Without this, our own
 * teardown-driven subscriptions.cancel would echo back as webhook events (or
 * an in-flight activation request would land) that upsert zombie records or
 * re-activate a disabled tenant.
 */
export const DELETION_GUARD = 'attribute_exists(pk) AND attribute_not_exists(deletionRequestedAt)';
