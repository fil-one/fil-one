import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Test-only helpers for building in-memory ZIP/OOXML archives so the OOXML
 * extractor can be exercised against real bytes without committing binary
 * fixtures. Not part of the package's public surface.
 */

interface ZipFile {
  name: string;
  data: string;
  /** When true, store uncompressed (method 0) instead of DEFLATE (method 8). */
  store?: boolean;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * Build a minimal but valid ZIP archive from the given files. Supports both the
 * STORED and DEFLATE methods, which is exactly the subset the reader handles.
 */
export function buildZip(files: ZipFile[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');
    const stored = file.store === true;
    const payload = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const crc = crc32(raw) >>> 0;

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      payload,
    ]);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);

    localParts.push(localHeader);
    centralParts.push(centralHeader);
    offset += localHeader.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(localSection.length),
    u16(0),
  ]);

  return new Uint8Array(Buffer.concat([localSection, centralDirectory, eocd]));
}

/**
 * Wrap Word `<w:p>` paragraph XML fragments into a complete `document.xml` and
 * package it as a .docx archive.
 */
export function buildDocx(bodyXml: string): Uint8Array {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyXml}</w:body></w:document>`;
  return buildZip([{ name: 'word/document.xml', data: document }]);
}

/**
 * Build a .pptx archive from a list of slide bodies (one entry per slide). Each
 * body is the inner XML of the slide's shape tree. Slides are named
 * `ppt/slides/slideN.xml` (1-based) in the order given.
 */
export function buildPptx(slideBodies: string[]): Uint8Array {
  const files = slideBodies.map((body, index) => ({
    name: `ppt/slides/slide${index + 1}.xml`,
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      `<p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
  }));
  return buildZip(files);
}

/**
 * Convenience: wrap plain text into a single-run Word paragraph.
 */
export function docxParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * Convenience: wrap plain text into a single-run PowerPoint paragraph.
 */
export function pptxParagraph(text: string): string {
  return `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
}
