import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.js';

/**
 * A parsed request body, or the 400 that says why it is not one.
 *
 * Two failures with one shape: a body that is not JSON, and a body that is
 * JSON but not what the route accepts. Both answer 400 with a message the
 * console shows the user, and the schema's own first issue is that message —
 * the field-level text a form needs ("Organization name can only contain
 * letters, numbers, spaces, hyphens, and periods") rather than a generic
 * "invalid request".
 */
export type ParsedBody<T> = { data: T } | { error: APIGatewayProxyStructuredResultV2 };

/**
 * The slice of a Zod schema this needs, described structurally.
 *
 * Zod itself is the shared package's dependency, not the backend's — every
 * schema arrives from `@filone/shared` — and importing it here would put a
 * second copy of the library in the resolution path.
 */
interface BodySchema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string }[] } };
}

function badRequest(message: string): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder().status(400).body<ErrorResponse>({ message }).build();
}

/** Parse and validate a request body in one step. */
export function parseJsonBody<T>(
  rawBody: string | undefined,
  schema: BodySchema<T>,
): ParsedBody<T> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return { error: badRequest('Invalid JSON body') };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: badRequest(parsed.error.issues[0].message) };
  }

  return { data: parsed.data };
}
