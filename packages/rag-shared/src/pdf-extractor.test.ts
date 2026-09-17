import { describe, expect, it } from 'vitest';

import { extractTextFromPdf } from './pdf-extractor.ts';
import { buildPdf } from './test-fixtures.ts';

describe('extractTextFromPdf', () => {
  it('extracts the text of a single-page PDF', async () => {
    expect(await extractTextFromPdf(buildPdf([['Hello world']]))).toBe('Hello world');
  });

  it('preserves line breaks within a page', async () => {
    const text = await extractTextFromPdf(buildPdf([['first line', 'second line']]));
    expect(text).toBe('first line\nsecond line');
  });

  it('joins pages with a blank line, in page order', async () => {
    const text = await extractTextFromPdf(buildPdf([['page one'], ['page two'], ['page three']]));
    expect(text).toBe('page one\n\npage two\n\npage three');
  });

  it('round-trips characters that are escaped in PDF strings', async () => {
    expect(await extractTextFromPdf(buildPdf([['a (b) \\ c']]))).toBe('a (b) \\ c');
  });

  it('returns an empty string for a PDF with no text layer (scanned page)', async () => {
    expect(await extractTextFromPdf(buildPdf([[]]))).toBe('');
  });

  it('skips textless pages without emitting extra separators', async () => {
    const text = await extractTextFromPdf(buildPdf([['before'], [], ['after']]));
    expect(text).toBe('before\n\nafter');
  });

  it('rejects bytes that are not a PDF', async () => {
    const bytes = new TextEncoder().encode('this is not a pdf');
    await expect(extractTextFromPdf(bytes)).rejects.toThrow(/Invalid PDF/i);
  });

  // pdf.js may detach the buffer it is handed. The caller's bytes must survive
  // extraction: the indexer reads the object once and would otherwise be left
  // holding an empty buffer.
  it('leaves the caller-provided buffer intact', async () => {
    const bytes = buildPdf([['Keep me intact']]);
    const byteLength = bytes.byteLength;

    await extractTextFromPdf(bytes);

    expect(bytes.byteLength).toBe(byteLength);
    expect(bytes[0]).toBe('%'.charCodeAt(0));
  });

  it('extracts a many-page document without holding every page at once', async () => {
    const pages = Array.from({ length: 300 }, (_, i) => [`page ${i}`]);
    const text = await extractTextFromPdf(buildPdf(pages));
    expect(text.split('\n\n')).toHaveLength(300);
    expect(text.startsWith('page 0\n\n')).toBe(true);
    expect(text.endsWith('\n\npage 299')).toBe(true);
  });

  // A document too large to parse safely must fail as an ordinary thrown error:
  // the indexer isolates that as one failed object, whereas an out-of-memory
  // kill would take down the whole worker invocation.
  it('throws (rather than risking an OOM) on a document beyond the page limit', async () => {
    const pages = Array.from({ length: 5001 }, () => ['x']);
    await expect(extractTextFromPdf(buildPdf(pages))).rejects.toThrow(
      /5001 pages.*5000-page limit/,
    );
  });

  it('is deterministic for identical input bytes', async () => {
    const bytes = buildPdf([['alpha', 'beta'], ['gamma']]);
    expect(await extractTextFromPdf(bytes)).toBe(await extractTextFromPdf(bytes));
  });
});
