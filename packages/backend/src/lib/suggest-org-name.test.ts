import { describe, it, expect } from 'vitest';
import { PUBLIC_EMAIL_DOMAINS, deriveOrgName, suggestOrgNameByEmail } from './suggest-org-name.js';

describe('suggestOrgNameByEmail', () => {
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
      expect(suggestOrgNameByEmail(email)).toBe(expected);
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
      expect(suggestOrgNameByEmail(email)).toBe(expected);
    });
  });

  describe('public email domains — strips special characters', () => {
    it.each([
      ['john+test@gmail.com', 'Johntest'],
      ['alice_bob@gmail.com', 'Alicebob'],
      ['user.name@gmail.com', 'User.name'],
      ['a+b@gmail.com', 'Ab'],
    ])('%s → %s', (email, expected) => {
      expect(suggestOrgNameByEmail(email)).toBe(expected);
    });

    it.each([
      ['all special chars local part', '+++@gmail.com'],
      ['single char after stripping', '+a@gmail.com'],
    ])('returns undefined for %s', (_label, email) => {
      expect(suggestOrgNameByEmail(email)).toBeUndefined();
    });
  });

  describe('all public domains are handled', () => {
    for (const domain of PUBLIC_EMAIL_DOMAINS) {
      it(`returns local part for ${domain}`, () => {
        expect(suggestOrgNameByEmail(`testuser@${domain}`)).toBe('Testuser');
      });
    }
  });

  describe('edge cases — returns undefined', () => {
    it.each([
      ['no @ sign', 'not-an-email'],
      ['empty domain', 'user@'],
    ])('%s', (_label, email) => {
      expect(suggestOrgNameByEmail(email)).toBeUndefined();
    });
  });
});

describe('deriveOrgName', () => {
  describe('name-based derivation — uses first name', () => {
    it.each([
      ['Alice', 'Alice Org'],
      ['Alice Johnson', 'Alice Org'],
      ['Bob   Williams Jr.', 'Bob Org'],
      ['JANE', 'Jane Org'],
      ['  alice  ', 'Alice Org'],
    ])('%s → %s', (name, expected) => {
      expect(deriveOrgName(name)).toBe(expected);
    });
  });

  describe('name-based derivation — strips disallowed chars from the first word', () => {
    it("apostrophe-free first word is kept (e.g. 'Sarah' from 'Sarah O\\'Brien')", () => {
      expect(deriveOrgName("Sarah O'Brien")).toBe('Sarah Org');
    });

    it('first word entirely outside [A-Za-z0-9 .-] falls through (no second-word lookup)', () => {
      // "张伟 Smith" → first word is non-Latin and gets stripped to empty; the
      // implementation does NOT examine the second word, so we fall through to
      // the email/default fallback.
      expect(deriveOrgName('张伟 Smith')).toBe('My Organization');
    });
  });

  describe('falls back to email when name is unusable', () => {
    it('first word too short after stripping', () => {
      expect(deriveOrgName('A', 'alice@acme.com')).toBe('Acme');
    });

    it('first word entirely disallowed chars', () => {
      expect(deriveOrgName('***', 'alice@acme.com')).toBe('Acme');
    });

    it('no name at all', () => {
      expect(deriveOrgName(undefined, 'alice@acme.com')).toBe('Acme');
    });

    it('empty-string name', () => {
      expect(deriveOrgName('', 'alice@acme.com')).toBe('Acme');
    });
  });

  describe('falls back to default when neither name nor email yields a value', () => {
    it('no inputs', () => {
      expect(deriveOrgName()).toBe('My Organization');
    });

    it('only undefined', () => {
      expect(deriveOrgName(undefined, undefined)).toBe('My Organization');
    });

    it('email is malformed', () => {
      expect(deriveOrgName(undefined, 'not-an-email')).toBe('My Organization');
    });

    it('name unusable + email malformed', () => {
      expect(deriveOrgName('A', 'not-an-email')).toBe('My Organization');
    });
  });

  describe('precedence — name wins over email when both yield a value', () => {
    it('uses name even when a corporate email is available', () => {
      expect(deriveOrgName('Charlie Smith', 'someone@acme.com')).toBe('Charlie Org');
    });
  });
});
