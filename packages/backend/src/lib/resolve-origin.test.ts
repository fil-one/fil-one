import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { resolveOrigin } from './resolve-origin.js';

const CANONICAL = 'https://app.fil.one';
const ALIAS = 'https://app.filone.ai';
const DEV = 'https://localhost:5173';

function eventWith(headers: Record<string, string | undefined>): APIGatewayProxyEventV2 {
  return { headers } as unknown as APIGatewayProxyEventV2;
}

describe('resolveOrigin', () => {
  beforeEach(() => {
    process.env.WEBSITE_URL = CANONICAL;
    process.env.ALLOWED_REDIRECT_ORIGINS = [CANONICAL, ALIAS, DEV].join(',');
  });

  afterEach(() => {
    delete process.env.WEBSITE_URL;
    delete process.env.ALLOWED_REDIRECT_ORIGINS;
  });

  it('falls back to WEBSITE_URL when no routing headers are present', () => {
    expect(resolveOrigin(eventWith({}))).toBe(CANONICAL);
  });

  it('falls back to WEBSITE_URL when the event has no headers at all', () => {
    expect(resolveOrigin({} as APIGatewayProxyEventV2)).toBe(CANONICAL);
  });

  it('follows the viewer host to an allowlisted alias', () => {
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': 'app.filone.ai' }))).toBe(ALIAS);
  });

  it('follows the viewer host to the canonical origin', () => {
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': 'app.fil.one' }))).toBe(CANONICAL);
  });

  it('lowercases the viewer host before matching', () => {
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': 'APP.FILONE.AI' }))).toBe(ALIAS);
  });

  it('trims surrounding whitespace from the viewer host', () => {
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': '  app.filone.ai  ' }))).toBe(ALIAS);
  });

  it('ignores an empty allowlist even for an otherwise valid host', () => {
    process.env.ALLOWED_REDIRECT_ORIGINS = '';
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': 'app.filone.ai' }))).toBe(CANONICAL);
  });

  it('ignores a missing allowlist even for an otherwise valid host', () => {
    delete process.env.ALLOWED_REDIRECT_ORIGINS;
    expect(resolveOrigin(eventWith({ 'x-forwarded-host': 'app.filone.ai' }))).toBe(CANONICAL);
  });

  // The execute-api URL is public, so x-forwarded-host is attacker-controlled on
  // that path. Each of these is a way an allowlist that did anything looser than
  // exact matching would leak an open redirect / OAuth redirect_uri.
  describe('rejects hostile viewer hosts', () => {
    it.for([
      ['an unrelated host', 'attacker.example'],
      ['a suffix attack on the canonical host', 'app.fil.one.attacker.example'],
      ['a suffix attack on the alias host', 'app.filone.ai.attacker.example'],
      ['a host that merely contains the alias', 'notapp.filone.ai'],
      ['comma-joined duplicate headers', 'app.filone.ai,attacker.example'],
      ['comma-joined with the hostile value first', 'attacker.example,app.filone.ai'],
      ['an explicit port', 'app.filone.ai:443'],
      ['userinfo smuggling', 'attacker.example#app.filone.ai'],
      ['a credentials prefix', 'app.filone.ai@attacker.example'],
      ['a scheme-relative URL', '//attacker.example'],
      ['a full URL rather than a host', 'https://attacker.example'],
      ['a full URL naming an allowed host', 'https://app.filone.ai'],
      ['an empty host', ''],
    ])('%s', ([, host]) => {
      expect(resolveOrigin(eventWith({ 'x-forwarded-host': host }))).toBe(CANONICAL);
    });
  });

  describe('x-dev-origin', () => {
    it('honours an allowlisted dev origin', () => {
      expect(resolveOrigin(eventWith({ 'x-dev-origin': DEV }))).toBe(DEV);
    });

    it('takes precedence over the viewer host', () => {
      expect(
        resolveOrigin(eventWith({ 'x-dev-origin': DEV, 'x-forwarded-host': 'app.filone.ai' })),
      ).toBe(DEV);
    });

    it('falls through to the viewer host when not allowlisted', () => {
      expect(
        resolveOrigin(
          eventWith({
            'x-dev-origin': 'https://attacker.example',
            'x-forwarded-host': 'app.filone.ai',
          }),
        ),
      ).toBe(ALIAS);
    });

    it('falls back to WEBSITE_URL when not allowlisted and no viewer host is present', () => {
      expect(resolveOrigin(eventWith({ 'x-dev-origin': 'https://attacker.example' }))).toBe(
        CANONICAL,
      );
    });
  });
});
