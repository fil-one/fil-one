import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * A value, or the response that refuses the request.
 *
 * `ok` discriminates, so a caller reads `if (!gate.ok) return gate.refusal;` and
 * then has `gate.value` narrowed. Monad-family rather than a bespoke union so the
 * next handler needing a gate can reuse it. Named `Result`, not `Maybe`: a true
 * Maybe discards the failure, and the response is the one thing the caller must
 * not lose.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: APIGatewayProxyStructuredResultV2 };

export const proceed = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = (refusal: APIGatewayProxyStructuredResultV2): Result<never> => ({
  ok: false,
  refusal,
});
