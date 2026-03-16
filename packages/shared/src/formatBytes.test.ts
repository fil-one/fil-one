import { describe, it, expect } from 'vitest';
import { formatBytes, formatBytesShort } from './formatBytes.js';

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1_000)).toBe('1 KB');
    expect(formatBytes(1_500)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1_000_000)).toBe('1 MB');
    expect(formatBytes(5_200_000)).toBe('5.2 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1_000_000_000)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1_000_000_000_000)).toBe('1 TB');
    expect(formatBytes(2_500_000_000_000)).toBe('2.5 TB');
  });

  it('trims trailing zeros', () => {
    expect(formatBytes(1_000_000)).toBe('1 MB');
  });
});

describe('formatBytesShort', () => {
  it('returns "0" for zero', () => {
    expect(formatBytesShort(0)).toBe('0');
  });

  it('formats without space between value and unit', () => {
    expect(formatBytesShort(1_000)).toBe('1K');
    expect(formatBytesShort(1_000_000)).toBe('1M');
    expect(formatBytesShort(1_000_000_000)).toBe('1G');
    expect(formatBytesShort(1_000_000_000_000)).toBe('1T');
  });

  it('rounds to whole numbers', () => {
    expect(formatBytesShort(1_500_000)).toBe('2M');
  });
});
