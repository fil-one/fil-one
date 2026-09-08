import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumePendingOrgPaymentPrompt,
  stashPendingOrgPaymentPrompt,
} from './pending-org-payment-prompt.js';

describe('pending-org-payment-prompt', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('answers true for the org the stash names', () => {
    stashPendingOrgPaymentPrompt('org-1');

    expect(consumePendingOrgPaymentPrompt('org-1')).toBe(true);
  });

  it('answers false for a different org', () => {
    stashPendingOrgPaymentPrompt('org-1');

    expect(consumePendingOrgPaymentPrompt('org-2')).toBe(false);
  });

  it('answers false with nothing stashed', () => {
    expect(consumePendingOrgPaymentPrompt('org-1')).toBe(false);
  });

  it('consumes the stash, so a second read answers false', () => {
    stashPendingOrgPaymentPrompt('org-1');

    expect(consumePendingOrgPaymentPrompt('org-1')).toBe(true);
    expect(consumePendingOrgPaymentPrompt('org-1')).toBe(false);
  });
});
