import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, CheckPromotionCodeRequestSchema } from '@filone/shared';
import type { CheckPromotionCodeResponse, ErrorResponse } from '@filone/shared';
import { takePromotionCodeCheck } from '../lib/promotion-code-rate-limit.ts';
import { describePromotionCode, findActivePromotionCode } from '../lib/promotion-codes.ts';
import { getStripeClient } from '../lib/stripe-client.ts';
import { getSubscription } from '../lib/subscription-store.ts';
import { ResponseBuilder } from '../lib/response-builder.ts';
import type { AuthenticatedEvent } from '../lib/user-context.ts';
import { getUserInfo } from '../lib/user-context.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { authorize } from '../middleware/authorize.ts';
import { csrfMiddleware } from '../middleware/csrf.ts';
import { errorHandlerMiddleware } from '../middleware/error-handler.ts';

/**
 * Says what a promo code would take off, so the payment modal can show the
 * discount before the card is submitted. Applies nothing: activation looks the
 * code up again through the same helper, so a code accepted here is one
 * activation accepts.
 *
 * Unlike activation, it needs no card, so it is the cheap way to guess codes.
 * Each org has an hourly limit of checks (`PROMOTION_CODE_CHECKS_PER_HOUR`);
 * past it this answers 429 with when to try again. Only a well-formed request
 * spends one.
 */
export async function baseHandler(
  event: AuthenticatedEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(event.body ?? '');
  } catch {
    return new ResponseBuilder().status(400).body({ message: 'Invalid JSON body.' }).build();
  }
  const parsed = CheckPromotionCodeRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return new ResponseBuilder()
      .status(400)
      .body({ message: 'Invalid request body.', issues: parsed.error.issues })
      .build();
  }

  const { orgId } = getUserInfo(event);
  const rateLimit = await takePromotionCodeCheck(orgId);
  if (!rateLimit.allowed) {
    const minutes = Math.max(1, Math.ceil((rateLimit.retryAt.getTime() - Date.now()) / 60_000));
    return new ResponseBuilder()
      .status(429)
      .body<ErrorResponse & { retryAt: string }>({
        message: `Too many promo code attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
        code: ApiErrorCode.PROMOTION_CODE_RATE_LIMITED,
        retryAt: rateLimit.retryAt.toISOString(),
      })
      .build();
  }

  // The org's Stripe customer, so a code restricted to another customer is
  // refused here rather than accepted and then refused at activation.
  const stripeCustomerId = (await getSubscription(orgId))?.stripeCustomerId;
  const promotionCode = await findActivePromotionCode(
    getStripeClient(),
    parsed.data.promotionCode,
    stripeCustomerId,
  );
  // A code whose coupon states no percentage or amount has nothing to preview,
  // and the customer is better told so now than surprised by the invoice.
  const discount = promotionCode && describePromotionCode(promotionCode);
  if (!discount) {
    return new ResponseBuilder()
      .status(400)
      .body({
        message: 'Invalid or expired promo code.',
        code: ApiErrorCode.INVALID_PROMOTION_CODE,
      })
      .build();
  }

  const response: CheckPromotionCodeResponse = { discount };
  return new ResponseBuilder().status(200).body(response).build();
}

export const handler = middy(baseHandler)
  .use(httpHeaderNormalizer())
  .use(authMiddleware())
  .use(authorize('billing.manage'))
  .use(csrfMiddleware())
  .use(errorHandlerMiddleware());
