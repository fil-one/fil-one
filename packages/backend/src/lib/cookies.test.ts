import { describe, it, expect } from 'vitest';
import { parseCookies } from './cookies.ts';

describe('parseCookies', () => {
  it('reads event.cookies, falling back to the Cookie header', () => {
    expect([
      parseCookies({ cookies: ['a=1', 'b=x=y'], headers: { cookie: 'ignored=1' } }),
      parseCookies({ headers: { cookie: 'a=1; b=x=y' } }),
      parseCookies({ headers: {} }),
    ]).toEqual([{ a: '1', b: 'x=y' }, { a: '1', b: 'x=y' }, {}]);
  });
});
