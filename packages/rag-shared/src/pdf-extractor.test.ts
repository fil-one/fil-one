import { describe, expect, it } from 'vitest';

import { extractTextFromPdf } from './pdf-extractor.js';
import { buildPdf } from './test-fixtures.js';

describe('extractTextFromPdf', () => {
  it('extracts text from a real PDF in-process (no external service)', async () => {
    const text = await extractTextFromPdf(buildPdf('Hello World'));
    expect(text).toContain('Hello World');
  });

  it('returns empty text for a PDF with no extractable text (empty/scanned)', async () => {
    const text = await extractTextFromPdf(buildPdf(''));
    expect(text.trim()).toBe('');
  });

  it('does not detach the caller-provided buffer', async () => {
    const bytes = buildPdf('Keep me intact');
    const before = bytes.byteLength;
    await extractTextFromPdf(bytes);
    expect(bytes.byteLength).toBe(before);
    // The bytes are still readable after extraction (buffer not transferred).
    expect(bytes[0]).toBe('%'.charCodeAt(0));
  });

  it('throws on bytes that are not a valid PDF', async () => {
    await expect(extractTextFromPdf(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow();
  });
});
