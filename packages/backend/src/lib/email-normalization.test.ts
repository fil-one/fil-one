import { describe, it, expect } from 'vitest';
import { normalizeEmailForEntitlement } from './email-normalization.js';

describe('normalizeEmailForEntitlement', () => {
  describe('Gmail family (gmail.com, googlemail.com)', () => {
    it('strips +suffix and lowercases', () => {
      expect(normalizeEmailForEntitlement('User+tag@gmail.com')).toBe('user@gmail.com');
    });

    it('strips dots and +suffix', () => {
      expect(normalizeEmailForEntitlement('u.s.e.r+tag@gmail.com')).toBe('user@gmail.com');
    });

    it('strips dots without +suffix', () => {
      expect(normalizeEmailForEntitlement('u.s.e.r@gmail.com')).toBe('user@gmail.com');
    });

    it('canonicalizes googlemail.com to gmail.com', () => {
      expect(normalizeEmailForEntitlement('u.s.e.r+tag@googlemail.com')).toBe('user@gmail.com');
    });

    it('lowercases domain', () => {
      expect(normalizeEmailForEntitlement('User@Gmail.COM')).toBe('user@gmail.com');
    });
  });

  describe('other PUBLIC_EMAIL_DOMAINS (no dot-stripping)', () => {
    it('strips +suffix but preserves dots for outlook.com', () => {
      expect(normalizeEmailForEntitlement('User+tag@outlook.com')).toBe('user@outlook.com');
    });

    it('strips +suffix for yahoo.com', () => {
      expect(normalizeEmailForEntitlement('user+tag@yahoo.com')).toBe('user@yahoo.com');
    });

    it('preserves dots for outlook.com', () => {
      expect(normalizeEmailForEntitlement('u.s.e.r@outlook.com')).toBe('u.s.e.r@outlook.com');
    });

    it('no-ops when there is no +suffix', () => {
      expect(normalizeEmailForEntitlement('user@outlook.com')).toBe('user@outlook.com');
    });
  });

  describe('unknown/corporate domains', () => {
    it('lowercases only — preserves +suffix', () => {
      expect(normalizeEmailForEntitlement('User+tag@corp.com')).toBe('user+tag@corp.com');
    });

    it('lowercases only — preserves dots', () => {
      expect(normalizeEmailForEntitlement('first.last@corp.com')).toBe('first.last@corp.com');
    });

    it('lowercases domain', () => {
      expect(normalizeEmailForEntitlement('User@Corp.Com')).toBe('user@corp.com');
    });
  });

  describe('edge cases', () => {
    it('returns lowercased input when there is no @ sign', () => {
      expect(normalizeEmailForEntitlement('notanemail')).toBe('notanemail');
    });

    it('handles multiple + signs — only the first segment is kept', () => {
      expect(normalizeEmailForEntitlement('user+a+b@gmail.com')).toBe('user@gmail.com');
    });
  });
});
