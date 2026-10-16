import { describe, it, expect } from 'vitest';

import { parseSearch, stringifySearch } from './search-params.js';

describe('the router search codec', () => {
  // Stripe returns to `/billing?portal_return=true`; a bucket folder or object
  // key can be anything, `123` and `null` included.
  it('keeps every value a string', () => {
    expect(parseSearch('?portal_return=true&prefix=123&key=null&versionId=1e3')).toEqual({
      portal_return: 'true',
      prefix: '123',
      key: 'null',
      versionId: '1e3',
    });
  });

  it('writes strings back unquoted, so they round-trip', () => {
    const search = { prefix: '123', region: 'us-east-1', key: 'true' };

    const str = stringifySearch(search);

    expect(str).toBe('?prefix=123&region=us-east-1&key=true');
    expect(parseSearch(str)).toEqual(search);
  });
});
