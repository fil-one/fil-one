import { describe, expect, it } from 'vitest';

import {
  getFileTypeLabel,
  getObjectFileName,
  getPreviewKind,
  isWithinPreviewLimit,
  PREVIEW_SIZE_LIMITS,
  shortenFileName,
} from './object-preview.js';

describe('getPreviewKind', () => {
  it.each([
    ['image/png', 'image'],
    ['video/mp4', 'video'],
    ['audio/mpeg', 'audio'],
    ['text/plain; charset=utf-8', 'text'],
    ['application/json', 'text'],
    ['application/ld+json', 'text'],
  ] as const)('reads %s as %s', (contentType, kind) => {
    expect(getPreviewKind('any-key', contentType)).toBe(kind);
  });

  it('shows HTML as text rather than rendering it', () => {
    expect(getPreviewKind('any-key.html', 'text/html')).toBe('text');
  });

  it('falls back to the extension when the content type is generic', () => {
    expect(getPreviewKind('any-folder/any-file.PNG', 'application/octet-stream')).toBe('image');
  });

  it('falls back to the extension when there is no content type', () => {
    expect(getPreviewKind('any-file.csv')).toBe('text');
  });

  it('offers no preview for a type it cannot show', () => {
    expect(getPreviewKind('any-file.zip', 'application/zip')).toBeNull();
  });

  it('offers no preview for a key without an extension or a useful type', () => {
    expect(getPreviewKind('any-folder/README')).toBeNull();
  });
});

describe('isWithinPreviewLimit', () => {
  it.each(['image', 'text'] as const)('loads a %s at its size limit', (kind) => {
    expect(isWithinPreviewLimit(kind, PREVIEW_SIZE_LIMITS[kind])).toBe(true);
  });

  it.each(['image', 'text'] as const)('skips a %s past its size limit', (kind) => {
    expect(isWithinPreviewLimit(kind, PREVIEW_SIZE_LIMITS[kind] + 1)).toBe(false);
  });

  it.each(['video', 'audio'] as const)('streams a %s of any size', (kind) => {
    expect(isWithinPreviewLimit(kind, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('getObjectFileName', () => {
  it('returns the last segment of a nested key', () => {
    expect(getObjectFileName('any-folder/nested/any-file.txt')).toBe('any-file.txt');
  });

  it('returns the whole key for a key ending in a slash', () => {
    expect(getObjectFileName('any-folder/')).toBe('any-folder/');
  });
});

describe('shortenFileName', () => {
  it('keeps a name at the limit whole', () => {
    expect(shortenFileName('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('cuts a long name in the middle, keeping its start and extension', () => {
    expect(
      shortenFileName('a_brilliant_clean_bright_white_plastic_74ac044b-68dc98a5500b_0.png'),
    ).toBe('a_brilliant_clean_b\u2026a5500b_0.png');
  });

  it('shortens to exactly the limit', () => {
    expect(shortenFileName('x'.repeat(100), 20)).toHaveLength(20);
  });
});

describe('getFileTypeLabel', () => {
  it.each([
    ['image/png', 'PNG image'],
    ['image/jpeg', 'JPEG image'],
    ['video/mp4', 'MP4 video'],
    ['audio/x-wav', 'WAV audio'],
    ['application/pdf', 'PDF document'],
    ['text/plain; charset=utf-8', 'Plain text'],
  ])('names %s as %s', (contentType, label) => {
    expect(getFileTypeLabel(contentType)).toBe(label);
  });

  it('returns a type it has no name for unchanged', () => {
    expect(getFileTypeLabel('application/vnd.any-vendor')).toBe('application/vnd.any-vendor');
  });
});
