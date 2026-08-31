import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getRequestHeader } from './request-headers.js';

function eventWith(headers: Record<string, string>): APIGatewayProxyEventV2 {
  return { headers } as unknown as APIGatewayProxyEventV2;
}

describe('getRequestHeader', () => {
  it('reads the normalized lower-case key', () => {
    expect(getRequestHeader(eventWith({ 'x-org-id': 'org-a' }), 'X-Org-Id')).toBe('org-a');
  });

  it('reads a key that arrived in the sender case', () => {
    expect(getRequestHeader(eventWith({ 'X-Org-Id': 'org-a' }), 'X-Org-Id')).toBe('org-a');
  });

  it('reads a key that arrived in any other case', () => {
    expect(getRequestHeader(eventWith({ 'X-ORG-ID': 'org-a' }), 'X-Org-Id')).toBe('org-a');
  });

  it('trims surrounding whitespace a proxy added', () => {
    expect(getRequestHeader(eventWith({ 'x-org-id': '  org-a  ' }), 'X-Org-Id')).toBe('org-a');
  });

  it('is undefined when the header is absent', () => {
    expect(getRequestHeader(eventWith({ 'x-csrf-token': 't' }), 'X-Org-Id')).toBeUndefined();
  });

  it('is undefined when the event carries no headers at all', () => {
    expect(getRequestHeader({} as APIGatewayProxyEventV2, 'X-Org-Id')).toBeUndefined();
  });
});
