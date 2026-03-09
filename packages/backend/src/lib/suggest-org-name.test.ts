import { describe, it, expect } from 'vitest';
import { suggestOrgName } from './suggest-org-name.js';

const userId = 'test-user-123';

describe('suggestOrgName', () => {
  it('returns capitalised domain name for a corporate email', () => {
    expect(suggestOrgName('alice@acme.com', userId)).toBe('Acme');
  });

  it('capitalises only the first letter', () => {
    expect(suggestOrgName('bob@filecoin.io', userId)).toBe('Filecoin');
  });

  it('returns undefined for undefined email', () => {
    expect(suggestOrgName(undefined, userId)).toBeUndefined();
  });

  it('returns undefined for email without @ sign', () => {
    expect(suggestOrgName('not-an-email', userId)).toBeUndefined();
  });

  it('returns undefined for email with empty domain', () => {
    expect(suggestOrgName('user@', userId)).toBeUndefined();
  });

  it('handles subdomains by using the first part', () => {
    expect(suggestOrgName('dev@eng.bigcorp.com', userId)).toBe('Eng');
  });

  it('is case-insensitive on the domain', () => {
    expect(suggestOrgName('user@ACME.COM', userId)).toBe('Acme');
  });

  describe('public email providers return undefined', () => {
    const publicDomains = [
      'gmail.com',
      'googlemail.com',
      'outlook.com',
      'hotmail.com',
      'live.com',
      'yahoo.com',
      'yahoo.co.uk',
      'ymail.com',
      'aol.com',
      'icloud.com',
      'me.com',
      'mac.com',
      'proton.me',
      'protonmail.com',
      'pm.me',
      'zoho.com',
      'mail.com',
      'gmx.com',
      'gmx.net',
      'fastmail.com',
      'tutanota.com',
      'tutamail.com',
      'tuta.io',
      'hey.com',
      'msn.com',
      'hotmail.co.uk',
      'yahoo.fr',
      'mail.ru',
      'yandex.com',
      'qq.com',
      '163.com',
      '126.com',
    ];

    for (const domain of publicDomains) {
      it(`returns undefined for ${domain}`, () => {
        expect(suggestOrgName(`user@${domain}`, userId)).toBeUndefined();
      });
    }
  });
});
