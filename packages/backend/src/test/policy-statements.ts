// Builders for the policy documents tests seed and send: the AWS shape with
// the ARN and Resource boilerplate filled in from bare member ids and actions.
import { POLICY_VERSION, buildStatement } from '@filone/shared';
import type { BucketPolicy, PolicyEffect, PolicyStatement } from '@filone/shared';

/**
 * A statement on `bucketName` for `principal` (member ids, or `*`), its
 * Resource derived from the actions. A label is spread in: `{ Sid, ...statement(...) }`.
 */
export function statement(
  bucketName: string,
  effect: PolicyEffect,
  principal: '*' | readonly string[],
  actions: PolicyStatement['Action'],
): PolicyStatement {
  return buildStatement({ bucketName, effect, principal, actions });
}

/** A document over `statements`. */
export function policyOf(...statements: PolicyStatement[]): BucketPolicy {
  return { Version: POLICY_VERSION, Statement: statements };
}
