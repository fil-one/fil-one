import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiErrorCode, roleHasPermission } from '@filone/shared';
import type { ErrorResponse } from '@filone/shared';
import { ResponseBuilder } from './response-builder.js';
import type { AuthenticatedEvent } from './user-context.js';
import { getUserInfo } from './user-context.js';

/**
 * Which keys a caller may see and revoke.
 *
 * `keys.manage_own` is the permission a Member holds, and the manifest declares
 * it on the list and delete routes — but a permission the handler ignores is a
 * permission that does not exist, and every one of those routes used to hand a
 * caller the whole org's inventory. This is the narrowing that makes the
 * declaration true.
 *
 * A key names its creator in `createdBy`, written since attribution shipped.
 * Rows older than that name nobody, and nobody may claim them: they are visible
 * and revocable only under `keys.manage_all`, so a Member cannot revoke a key
 * that might be the org's rather than theirs.
 */
export type KeyScope =
  /** `keys.manage_all` — every key in the org, including unattributed rows. */
  | { sees: 'all' }
  /** `keys.manage_own` only — the keys this user created, and no others. */
  | { sees: 'own'; userId: string }
  /** Neither permission: no key belongs to this caller's view at all. */
  | { sees: 'none' };

/** The caller's key scope, read from the role their membership row carries. */
export function keyScope(event: AuthenticatedEvent): KeyScope {
  const { userId, membership } = getUserInfo(event);
  const role = membership?.role ?? '';

  if (roleHasPermission(role, 'keys.manage_all')) return { sees: 'all' };
  if (roleHasPermission(role, 'keys.manage_own')) return { sees: 'own', userId };
  return { sees: 'none' };
}

/** Whether a stored key belongs to the caller under this scope. */
export function withinScope(scope: KeyScope, createdBy: string | undefined): boolean {
  if (scope.sees === 'all') return true;
  if (scope.sees === 'none') return false;
  return createdBy !== undefined && createdBy === scope.userId;
}

/**
 * The refusal for acting on someone else's key.
 *
 * `FORBIDDEN_ROLE` rather than a 404: the caller is a member of the org the key
 * belongs to and is allowed to know it exists — they listed it, or they are
 * retrying against a stale page — and telling them their role is the reason is
 * what makes the message actionable.
 */
export function notYourKeyResponse(): APIGatewayProxyStructuredResultV2 {
  return new ResponseBuilder()
    .status(403)
    .body<ErrorResponse>({
      message: 'Your role in this organization only permits revoking keys you created.',
      code: ApiErrorCode.FORBIDDEN_ROLE,
    })
    .build();
}
