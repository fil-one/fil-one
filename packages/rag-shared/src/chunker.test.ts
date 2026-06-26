import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { chunk } from './chunker.js';
import { DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP_SIZE } from './constants.js';

function hashChunks(chunks: string[]): string {
  return createHash('sha256').update(JSON.stringify(chunks)).digest('hex');
}

describe('chunk', () => {
  it('returns a single chunk when the text fits within chunkSize', () => {
    const result = chunk('short text', { chunkSize: 100, overlapSize: 10 });
    expect(result).toEqual(['short text']);
  });

  it('keeps every chunk within chunkSize', () => {
    const text = 'word '.repeat(500); // ~2500 chars
    const result = chunk(text, { chunkSize: 200, overlapSize: 40 });
    expect(result.length).toBeGreaterThan(1);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(200);
    }
  });

  it('carries the configured overlap between consecutive chunks', () => {
    // Distinct numbered words so we can see the tail of one chunk reappear at
    // the head of the next.
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const overlapSize = 30;
    const result = chunk(words, { chunkSize: 120, overlapSize });
    expect(result.length).toBeGreaterThan(2);

    for (let i = 0; i < result.length - 1; i++) {
      const tail = result[i]!.slice(-overlapSize);
      // Some suffix of the current chunk must appear at the start of the next.
      const next = result[i + 1]!;
      // The overlap is approximate to word boundaries, so assert a shared
      // substring of meaningful length rather than exact equality.
      const sharedWord = tail.trim().split(' ').at(-1)!;
      expect(next.startsWith(sharedWord) || next.includes(sharedWord)).toBe(true);
    }
  });

  it('normalizes whitespace: runs of spaces/tabs/newlines collapse to one space', () => {
    const result = chunk('alpha   beta\t\tgamma\n\n\ndelta', { chunkSize: 100, overlapSize: 0 });
    expect(result).toEqual(['alpha beta gamma delta']);
  });

  it('prefers paragraph boundaries over arbitrary cuts', () => {
    const para1 = 'a'.repeat(80);
    const para2 = 'b'.repeat(80);
    const result = chunk(`${para1}\n\n${para2}`, { chunkSize: 100, overlapSize: 0 });
    expect(result).toEqual([para1, para2]);
  });

  it('uses defaults of 1000/200 when no options are given', () => {
    const text = 'x'.repeat(3000);
    const result = chunk(text);
    expect(DEFAULT_CHUNK_SIZE).toBe(1000);
    expect(DEFAULT_OVERLAP_SIZE).toBe(200);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(DEFAULT_CHUNK_SIZE);
    }
    expect(result.length).toBeGreaterThan(1);
  });

  it('hard-splits a single oversized token rather than wedging', () => {
    const result = chunk('y'.repeat(250), { chunkSize: 100, overlapSize: 0 });
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(100);
    }
    expect(result.join('')).toBe('y'.repeat(250));
  });

  it('is deterministic: identical input yields identical chunks', () => {
    const text = 'The quick brown fox. '.repeat(300);
    const a = chunk(text, { chunkSize: 250, overlapSize: 50 });
    const b = chunk(text, { chunkSize: 250, overlapSize: 50 });
    expect(hashChunks(a)).toBe(hashChunks(b));
    expect(a).toEqual(b);
  });

  it('throws on empty or whitespace-only text', () => {
    expect(() => chunk('')).toThrow(/cannot be empty/);
    expect(() => chunk('   \n\t ')).toThrow(/cannot be empty/);
  });

  it('throws when overlapSize is not smaller than chunkSize', () => {
    expect(() => chunk('text', { chunkSize: 100, overlapSize: 100 })).toThrow(
      /overlapSize must be smaller/,
    );
    expect(() => chunk('text', { chunkSize: 100, overlapSize: 150 })).toThrow(
      /overlapSize must be smaller/,
    );
  });

  it('throws on a non-positive chunkSize or negative overlap', () => {
    expect(() => chunk('text', { chunkSize: 0 })).toThrow(/chunkSize must be a positive/);
    expect(() => chunk('text', { chunkSize: -10 })).toThrow(/chunkSize must be a positive/);
    expect(() => chunk('text', { chunkSize: 100, overlapSize: -1 })).toThrow(
      /overlapSize cannot be negative/,
    );
  });
});
