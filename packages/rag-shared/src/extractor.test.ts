import { describe, expect, it } from 'vitest';

import { extractText } from './extractor.js';
import { buildDocx, buildPdf, buildPptx, docxParagraph, pptxParagraph } from './test-fixtures.js';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('extractText', () => {
  describe('plain text and markdown', () => {
    it('decodes text/plain as UTF-8', async () => {
      expect(await extractText(encode('hello world'), 'text/plain')).toBe('hello world');
    });

    it('decodes text/markdown verbatim (no parsing)', async () => {
      const md = '# Title\n\n- bullet **bold**';
      expect(await extractText(encode(md), 'text/markdown')).toBe(md);
    });

    it('round-trips emoji and accented characters losslessly', async () => {
      const text = 'café — naïve — 🚀 — Привет';
      expect(await extractText(encode(text), 'text/plain')).toBe(text);
    });

    it('tolerates a content-type with parameters and casing', async () => {
      expect(await extractText(encode('x'), 'TEXT/PLAIN; charset=utf-8')).toBe('x');
    });

    it('treats unknown text/* subtypes as plain UTF-8', async () => {
      expect(await extractText(encode('raw'), 'text/x-rst')).toBe('raw');
    });

    it('rejects invalid UTF-8 bytes', async () => {
      // 0xff is never a valid UTF-8 lead byte.
      await expect(extractText(new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain')).rejects.toThrow(
        /not valid UTF-8/,
      );
    });
  });

  describe('html', () => {
    it('strips markup and returns readable text', async () => {
      const html = '<html><body><script>x</script><p>Hello &amp; bye</p></body></html>';
      expect(await extractText(encode(html), 'text/html')).toBe('Hello & bye');
    });
  });

  describe('docx', () => {
    it('extracts text from a Word document', async () => {
      const docx = buildDocx(docxParagraph('Document text') + docxParagraph('second'));
      expect(
        await extractText(
          docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe('Document text\nsecond');
    });
  });

  describe('pptx', () => {
    it('extracts text from a PowerPoint deck', async () => {
      const pptx = buildPptx([pptxParagraph('Slide one'), pptxParagraph('Slide two')]);
      expect(
        await extractText(
          pptx,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ),
      ).toBe('Slide one\nSlide two');
    });
  });

  describe('pdf', () => {
    it('extracts PDF text in-process (unpdf), no options required', async () => {
      const text = await extractText(buildPdf('pdf line'), 'application/pdf');
      expect(text).toContain('pdf line');
    });
  });

  it('throws on an unsupported content type', async () => {
    await expect(extractText(encode('x'), 'application/zip')).rejects.toThrow(
      /Unsupported content type/,
    );
  });

  describe('determinism', () => {
    it('produces identical output for identical bytes across formats', async () => {
      const html = encode('<div>Deterministic &amp; <b>stable</b></div>');
      expect(await extractText(html, 'text/html')).toBe(await extractText(html, 'text/html'));

      const docx = buildDocx(docxParagraph('alpha') + docxParagraph('beta'));
      expect(
        await extractText(
          docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe(
        await extractText(
          docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      );

      const pptx = buildPptx([pptxParagraph('one'), pptxParagraph('two')]);
      const type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      expect(await extractText(pptx, type)).toBe(await extractText(pptx, type));
    });
  });
});
