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

  describe('public email domains — strips special characters', () => {
    it.each([
      ['john+test@gmail.com', 'Johntest'],
      ['alice_bob@gmail.com', 'Alicebob'],
      ['user.name@gmail.com', 'User.name'],
      ['a+b@gmail.com', 'Ab'],
    ])('%s → %s', (email, expected) => {
      expect(suggestOrgName(email)).toBe(expected);
    });

    it.each([
      ['all special chars local part', '+++@gmail.com'],
      ['single char after stripping', '+a@gmail.com'],
    ])('returns undefined for %s', (_label, email) => {
      expect(suggestOrgName(email)).toBeUndefined();
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
