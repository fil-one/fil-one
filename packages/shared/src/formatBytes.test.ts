import { describe, it, expect } from 'vitest';
import { formatBytes, formatBytesShort, bytesAxisFormatter } from './formatBytes.js';

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

describe('bytesAxisFormatter', () => {
  it('renders every tick in the unit taken from the top of the domain', () => {
    const format = bytesAxisFormatter(30_000_000);
    expect([0, 10_000_000, 20_000_000, 30_000_000].map(format)).toEqual(['0', '10M', '20M', '30M']);
  });

  it('does not switch units between neighbouring ticks', () => {
    // formatBytesShort would label this axis 0 · 500K · 1M · 2M · 2M: two
    // magnitudes on one axis, and 1.5 MB and 2 MB sharing a label.
    const format = bytesAxisFormatter(2_000_000);
    expect([0, 500_000, 1_000_000, 1_500_000, 2_000_000].map(format)).toEqual([
      '0',
      '0.5M',
      '1M',
      '1.5M',
      '2M',
    ]);
  });

  it('never repeats a label across distinct ticks', () => {
    const ticks = [0, 500_000, 1_000_000, 1_500_000, 2_000_000];
    const labels = ticks.map(bytesAxisFormatter(2_000_000));
    expect(new Set(labels).size).toBe(ticks.length);
  });

  it('keeps whole values free of a trailing decimal', () => {
    expect(bytesAxisFormatter(4_000)(2_000)).toBe('2K');
  });

  it('falls back to bytes for an empty domain', () => {
    const format = bytesAxisFormatter(0);
    expect(format(0)).toBe('0');
    expect(format(5)).toBe('5B');
  });

  it('handles a terabyte domain without running off the unit table', () => {
    expect(bytesAxisFormatter(3e12)(1.5e12)).toBe('1.5T');
    expect(bytesAxisFormatter(5e15)(1e15)).toBe('1000T');
  });
});
