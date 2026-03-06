import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Determines the origin to use for redirects and callback URLs.
 * In production, always returns WEBSITE_URL. In non-production stages,
 * honours the X-Dev-Origin header if it matches ALLOWED_REDIRECT_ORIGINS.
 */
export function resolveOrigin(event: APIGatewayProxyEventV2): string {
  const websiteUrl = process.env.WEBSITE_URL!;
  const allowed = process.env.ALLOWED_REDIRECT_ORIGINS?.split(',') ?? [];
  const devOrigin = event.headers?.['x-dev-origin'];
  return devOrigin && allowed.includes(devOrigin) ? devOrigin : websiteUrl;
}
