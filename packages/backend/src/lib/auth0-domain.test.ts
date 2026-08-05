import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { resolveAuth0Domain } from './auth0-domain.js';

const CONFIGURED = 'dev-tenant.us.auth0.com';

function eventWith(headers: Record<string, string | undefined>): APIGatewayProxyEventV2 {
  return { headers } as unknown as APIGatewayProxyEventV2;
}

describe('resolveAuth0Domain', () => {
  beforeEach(() => {
    process.env.AUTH0_DOMAIN = CONFIGURED;
  });

  afterEach(() => {
    delete process.env.AUTH0_DOMAIN;
  });

  it('falls back to the configured domain when no viewer host is present', () => {
    expect(resolveAuth0Domain(eventWith({}))).toBe(CONFIGURED);
  });

  it('falls back when the event has no headers at all', () => {
    expect(resolveAuth0Domain({} as APIGatewayProxyEventV2)).toBe(CONFIGURED);
  });

  it('uses the custom domain for the canonical console host', () => {
    expect(resolveAuth0Domain(eventWith({ 'x-forwarded-host': 'app.fil.one' }))).toBe(
      'auth.fil.one',
    );
  });

  // The whole point of the alias: its login flow must not touch the flagged TLD.
  it('uses the tenant domain for the demo alias host', () => {
    expect(resolveAuth0Domain(eventWith({ 'x-forwarded-host': 'app.filone.ai' }))).toBe(
      'fil-one.us.auth0.com',
    );
  });

  it('normalises host casing and whitespace', () => {
    expect(resolveAuth0Domain(eventWith({ 'x-forwarded-host': '  APP.FILONE.AI ' }))).toBe(
      'fil-one.us.auth0.com',
    );
  });

  // x-forwarded-host is attacker-controlled on the public execute-api path, so
  // anything not in the table must land on the stage's configured domain rather
  // than somewhere of the caller's choosing.
  it.for([
    ['an unrelated host', 'attacker.example'],
    ['a suffix attack', 'app.fil.one.attacker.example'],
    ['a prefix attack', 'app.filone.ai.attacker.example'],
    ['comma-joined duplicate headers', 'app.filone.ai,attacker.example'],
    ['an explicit port', 'app.filone.ai:443'],
    ['a full URL rather than a host', 'https://app.filone.ai'],
    ['an empty host', ''],
  ])('ignores %s', ([, host]) => {
    expect(resolveAuth0Domain(eventWith({ 'x-forwarded-host': host }))).toBe(CONFIGURED);
  });
});
