import { describe, expect, it } from 'vitest';
import { resolveContentType } from './rag-content-type.js';

describe('resolveContentType', () => {
  it('prefers a specific stored content type', () => {
    expect(resolveContentType('notes', 'text/markdown')).toBe('text/markdown');
    expect(resolveContentType('doc.bin', 'application/pdf')).toBe('application/pdf');
  });

  it('drops parameters and lower-cases the stored type', () => {
    expect(resolveContentType('a', 'TEXT/HTML; charset=utf-8')).toBe('text/html');
  });

  it('falls back to the extension when the stored type is generic', () => {
    expect(resolveContentType('report.pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(resolveContentType('readme.md', 'binary/octet-stream')).toBe('text/markdown');
    expect(resolveContentType('page.html', '')).toBe('text/html');
  });

  it('falls back to the extension when no stored type is given', () => {
    expect(resolveContentType('notes.txt')).toBe('text/plain');
    expect(resolveContentType('slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(resolveContentType('letter.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('is case-insensitive on the extension', () => {
    expect(resolveContentType('REPORT.PDF')).toBe('application/pdf');
  });

  it('returns undefined for unknown extensions and no usable stored type', () => {
    expect(resolveContentType('archive.zip')).toBeUndefined();
    expect(resolveContentType('noextension')).toBeUndefined();
    expect(resolveContentType('trailing.')).toBeUndefined();
    expect(resolveContentType('image.png', 'application/octet-stream')).toBeUndefined();
  });
});
