import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AUTH0_DOMAIN_BY_CONSOLE_ORIGIN, Stage } from '@filone/shared';

/**
 * The Auth0 domain this request authenticates against.
 *
 * Keyed on the request host, not on `resolveOrigin`: cookies carry no `Domain=`
 * attribute, so a session on one hostname is never sent to the other and the
 * issuing domain is a pure function of the host. Deliberately ignores
 * `x-dev-origin`, which must never select an Auth0 domain.
 *
 * `x-forwarded-host` is set from `Host` by the Router's viewer-request function but
 * is attacker-controlled on the public execute-api path, so the closed table is the
 * only gate. An unrecognised host falls back to the stage's configured domain, and
 * forging a recognised one only selects a domain whose `iss` and audience then fail
 * validation — it can deny a login, never complete one.
 *
 * The table is consulted on the production stage alone: every domain in it belongs
 * to the production Auth0 tenant, and the demo aliases exist only on the production
 * distribution. Without the stage check a staging or ephemeral deployment handed a
 * forged production host would point its login at the production tenant.
 *
 * Rationale for the mapping: AUTH0_DOMAIN_BY_CONSOLE_ORIGIN in @filone/shared.
 */
export function resolveAuth0Domain(event: APIGatewayProxyEventV2): string {
  const configured = process.env.AUTH0_DOMAIN!;
  if (process.env.FILONE_STAGE !== Stage.Production) return configured;
  const host = event.headers?.['x-forwarded-host']?.trim().toLowerCase();
  if (!host) return configured;
  return AUTH0_DOMAIN_BY_CONSOLE_ORIGIN[`https://${host}`] ?? configured;
}
