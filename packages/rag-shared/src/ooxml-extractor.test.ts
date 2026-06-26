import { describe, expect, it } from 'vitest';

import { extractTextFromDocx, extractTextFromPptx } from './ooxml-extractor.js';
import { buildDocx, buildPptx, buildZip, docxParagraph, pptxParagraph } from './test-fixtures.js';

describe('extractTextFromDocx', () => {
  it('reads <w:t> runs from a simple paragraph', () => {
    const docx = buildDocx(docxParagraph('Hello world'));
    expect(extractTextFromDocx(docx)).toBe('Hello world');
  });

  it('joins adjacent runs within a paragraph without extra spacing', () => {
    const body =
      '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>';
    expect(extractTextFromDocx(buildDocx(body))).toBe('Hello world');
  });

  it('preserves tab boundaries as \\t', () => {
    const body = '<w:p><w:r><w:t>left</w:t><w:tab/><w:t>right</w:t></w:r></w:p>';
    expect(extractTextFromDocx(buildDocx(body))).toBe('left\tright');
  });

  it('preserves line breaks as \\n within a paragraph', () => {
    const body = '<w:p><w:r><w:t>top</w:t><w:br/><w:t>bottom</w:t></w:r></w:p>';
    expect(extractTextFromDocx(buildDocx(body))).toBe('top\nbottom');
  });

  it('separates paragraphs with a newline', () => {
    const body = docxParagraph('para one') + docxParagraph('para two');
    expect(extractTextFromDocx(buildDocx(body))).toBe('para one\npara two');
  });

  it('throws on an archive missing word/document.xml', () => {
    const bogus = buildZip([{ name: 'word/other.xml', data: '<x/>' }]);
    expect(() => extractTextFromDocx(bogus)).toThrow(/missing word\/document\.xml/);
  });

  it('throws on bytes that are not a ZIP archive', () => {
    expect(() => extractTextFromDocx(new TextEncoder().encode('not a zip'))).toThrow(
      /Malformed ZIP/,
    );
  });

  it('extracts despite unrelated bomb entries the extractor never reads', () => {
    // A 40 MB-uncompressed entry that DEFLATEs tiny — above the 32 MB default
    // per-entry cap. If readZip inflated every entry eagerly this would throw;
    // lazy decompression means only word/document.xml is inflated, so extraction
    // succeeds.
    const document =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${docxParagraph('Hello world')}</w:body></w:document>`;
    const docx = buildZip([
      { name: 'word/document.xml', data: document },
      { name: 'bloat.bin', data: new Uint8Array(40 * 1024 * 1024) },
    ]);
    expect(extractTextFromDocx(docx)).toBe('Hello world');
  });

  it('is deterministic for identical bytes', () => {
    const body = docxParagraph('alpha') + docxParagraph('beta');
    const docx = buildDocx(body);
    expect(extractTextFromDocx(docx)).toBe(extractTextFromDocx(docx));
  });
});

describe('extractTextFromPptx', () => {
  it('reads <a:t> runs from a slide', () => {
    const pptx = buildPptx([pptxParagraph('Slide content')]);
    expect(extractTextFromPptx(pptx)).toBe('Slide content');
  });

  it('preserves tab and line-break boundaries inside a slide', () => {
    const body =
      '<a:p><a:r><a:t>a</a:t></a:r><a:r><a:tab/><a:t>b</a:t></a:r><a:br/><a:r><a:t>c</a:t></a:r></a:p>';
    expect(extractTextFromPptx(buildPptx([body]))).toBe('a\tb\nc');
  });

  it('orders slide parts by numeric natural sort (slide2 before slide10)', () => {
    // 12 slides, each carrying its own number, so we can assert ordering.
    const bodies = Array.from({ length: 12 }, (_, i) => pptxParagraph(`Slide ${i + 1}`));
    const pptx = buildPptx(bodies);

    const text = extractTextFromPptx(pptx);
    const lines = text.split('\n');

    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('Slide 1');
    expect(lines[1]).toBe('Slide 2');
    expect(lines[8]).toBe('Slide 9');
    // The natural-sort guarantee: slide10 comes after slide9, not after slide1.
    expect(lines[9]).toBe('Slide 10');
    expect(lines[10]).toBe('Slide 11');
    expect(lines[11]).toBe('Slide 12');

    // Slide 2 must precede slide 10 in the output.
    expect(text.indexOf('Slide 2')).toBeLessThan(text.indexOf('Slide 10'));
  });

  it('sorts numerically even when the archive lists slides out of order', () => {
    // Manually build the zip with slide10 stored before slide2.
    const slideXml = (n: number): string =>
      '<?xml version="1.0"?>' +
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>' +
      `<a:p><a:r><a:t>n${n}</a:t></a:r></a:p>` +
      '</p:spTree></p:cSld></p:sld>';
    const pptx = buildZip([
      { name: 'ppt/slides/slide10.xml', data: slideXml(10) },
      { name: 'ppt/slides/slide2.xml', data: slideXml(2) },
      { name: 'ppt/slides/slide1.xml', data: slideXml(1) },
    ]);
    expect(extractTextFromPptx(pptx)).toBe('n1\nn2\nn10');
  });

  it('throws when there are no slides', () => {
    const pptx = buildZip([{ name: 'ppt/presentation.xml', data: '<x/>' }]);
    expect(() => extractTextFromPptx(pptx)).toThrow(/no slides found/);
  });

  it('is deterministic for identical bytes', () => {
    const pptx = buildPptx([pptxParagraph('one'), pptxParagraph('two')]);
    expect(extractTextFromPptx(pptx)).toBe(extractTextFromPptx(pptx));
  });
});
