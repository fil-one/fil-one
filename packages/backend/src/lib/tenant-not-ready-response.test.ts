import { describe, it, expect } from 'vitest';
import { tenantNotReadyResponse } from './tenant-not-ready-response.js';

describe('tenantNotReadyResponse', () => {
  it('returns a 503 with the setup-incomplete message', () => {
    const result = tenantNotReadyResponse();
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body as string);
    expect(body).toEqual({
      message: 'We are still setting up the region for you. Please try again in a moment.',
    });
  });
});
