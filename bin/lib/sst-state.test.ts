import { describe, expect, it } from 'vitest';
import { isFlociShell } from './sst-state.ts';

describe('isFlociShell', () => {
  it('accepts a shell with LOCAL=true and an AWS endpoint', () => {
    expect(isFlociShell({ LOCAL: 'true', AWS_ENDPOINT_URL: 'http://any-host:4566' })).toBe(true);
  });

  it.each([
    ['LOCAL is unset', { AWS_ENDPOINT_URL: 'http://any-host:4566' }],
    ['LOCAL is not "true"', { LOCAL: '1', AWS_ENDPOINT_URL: 'http://any-host:4566' }],
    ['AWS_ENDPOINT_URL is unset', { LOCAL: 'true' }],
    ['AWS_ENDPOINT_URL is empty', { LOCAL: 'true', AWS_ENDPOINT_URL: '' }],
  ])('rejects a shell where %s', (_case, env) => {
    expect(isFlociShell(env)).toBe(false);
  });
});
