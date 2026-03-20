import { describe, it, expect } from 'vitest';
import { PUBLIC_EMAIL_DOMAINS, suggestOrgName } from './suggest-org-name.js';

describe('suggestOrgName', () => {
  describe('corporate emails — uses domain name', () => {
    it.each([
      ['alice@acme.com', 'Acme'],
      ['bob@filecoin.io', 'Filecoin'],
      ['user@ACME.COM', 'Acme'],
      ['dev@eng.bigcorp.com', 'Bigcorp'],
      ['dev@eng.bigcorp.co.uk', 'Bigcorp'],
      ['ceo@startup.org', 'Startup'],
      ['info@my-company.com', 'My Company'],
      ['user@some-long-name.co.uk', 'Some Long Name'],
      ['user@protocol.labs', 'Protocol'],
    ])('%s → %s', (email, expected) => {
      expect(suggestOrgName(email)).toBe(expected);
    });
  });

  describe('public email domains — uses local part', () => {
    it.each([
      ['alice@gmail.com', 'Alice'],
      ['Bob.Smith@outlook.com', 'Bob.smith'],
      ['JANE@yahoo.com', 'Jane'],
      ['satoshi@protonmail.com', 'Satoshi'],
      ['user123@icloud.com', 'User123'],
      ['someone@hey.com', 'Someone'],
    ])('%s → %s', (email, expected) => {
      expect(suggestOrgName(email)).toBe(expected);
    });
  });

  describe('all public domains are handled', () => {
    for (const domain of PUBLIC_EMAIL_DOMAINS) {
      it(`returns local part for ${domain}`, () => {
        expect(suggestOrgName(`testuser@${domain}`)).toBe('Testuser');
      });
    }
  });

  describe('edge cases — returns undefined', () => {
    it.each([
      ['no @ sign', 'not-an-email'],
      ['empty domain', 'user@'],
    ])('%s', (_label, email) => {
      expect(suggestOrgName(email)).toBeUndefined();
    });
  });
});
