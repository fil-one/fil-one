import { extractText } from 'unpdf';

/**
 * Extract text from a PDF entirely in-process using
 * {@link https://github.com/unjs/unpdf | unpdf} — a pure-JavaScript build of
 * PDF.js compiled for serverless runtimes (no web worker, no native
 * dependencies, no external service). This replaces the previous Amazon
 * Textract path, which could only read PDFs staged in an AWS S3 bucket and so
 * never worked against the tenant's external (Aurora/FTH) buckets.
 *
 * The document is parsed and every page's text is concatenated in reading
 * order. A PDF with no extractable text (empty, or scanned/image-only with no
 * OCR) yields empty/whitespace text — the indexer treats that as "nothing to
 * index" and skips the object. A malformed/corrupt PDF throws, which the
 * indexer isolates as a per-object `'failed'`.
 *
 * @throws if the bytes cannot be parsed as a PDF.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  // unpdf/PDF.js may detach the backing ArrayBuffer while parsing, so hand it a
  // private copy rather than the caller's buffer.
  const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
  return text;
}
