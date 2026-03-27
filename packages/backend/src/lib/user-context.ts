import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface UserInfo {
  sub: string;
  userId: string;
  orgId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export interface AuthenticatedEvent extends APIGatewayProxyEventV2 {
  requestContext: APIGatewayProxyEventV2['requestContext'] & {
    userInfo: UserInfo;
  };
}

export function getUserInfo(event: AuthenticatedEvent): UserInfo {
  return event.requestContext.userInfo;
}

/**
 * Signal the auth middleware to force a token refresh after the handler completes.
 * Use this when a handler modifies Auth0 user data (name, email, etc.) so the
 * response includes fresh cookies with updated ID token claims.
 */
export function requestTokenRefresh(event: AuthenticatedEvent): void {
  (
    event.requestContext as AuthenticatedEvent['requestContext'] & {
      _forceTokenRefresh?: boolean;
    }
  )._forceTokenRefresh = true;
}
