import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.js';

/**
 * Self-serve deletion is withheld until Aurora exposes a tenant DELETE
 * (FIL-919): the teardown only disables an Aurora tenant, so an org's buckets
 * and objects survive its own deletion. The `customer.deleted` trigger is
 * deliberately not gated — it is the trial-abuse response and accepts that
 * residue.
 *
 * Read per call so tests can flip it. Keep in step with
 * ACCOUNT_DELETION_ENABLED in packages/website/src/lib/account-deletion.ts.
 */
export function isSelfServeDeletionEnabled(): boolean {
  return process.env.ACCOUNT_DELETION_ENABLED === 'true';
}

export function selfServeDeletionUnavailable(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(501)
    .body<ErrorResponse>({
      message: 'Organization deletion is not available yet. Contact support@fil.one.',
    })
    .build();
}
