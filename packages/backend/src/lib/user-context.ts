import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface UserInfo {
  userId: string;
  orgId: string;
  email?: string;
  emailVerified: boolean;
}

export interface AuthenticatedEvent extends APIGatewayProxyEventV2 {
  requestContext: APIGatewayProxyEventV2['requestContext'] & {
    userInfo: UserInfo;
  };
}

export function getUserInfo(event: AuthenticatedEvent): UserInfo {
  return event.requestContext.userInfo;
}
