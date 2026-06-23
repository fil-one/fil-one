import { extractTextFromHtml } from './html-extractor.js';
import { extractTextFromDocx, extractTextFromPptx } from './ooxml-extractor.js';
import { extractTextFromPdf, type PdfExtractionOptions } from './pdf-extractor.js';

/**
 * Content types understood by {@link extractText}. Any `text/*` type not listed
 * here is treated as plain UTF-8 text.
 */
const CONTENT_TYPE = {
  pdf: 'application/pdf',
  plain: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

/**
 * Options accepted by {@link extractText}.
 */
export interface ExtractOptions {
  /** Options forwarded to the PDF/Textract extractor when `contentType` is a PDF. */
  pdf?: PdfExtractionOptions;
}

/**
 * Decode bytes as UTF-8 text. Uses a fatal decoder so invalid UTF-8 is rejected
 * rather than silently replaced, keeping extraction lossless and deterministic.
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Input is not valid UTF-8 text');
  }
}

/**
 * Normalise a raw content type to its bare MIME type, dropping any parameters
 * (e.g. `text/html; charset=utf-8` -> `text/html`) and lower-casing it.
 */
function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/**
 * Extract readable, normalized plain text from uploaded document bytes.
 *
 * Supported content types: PDF (via Textract), plain text, Markdown, HTML, Word
 * (.docx) and PowerPoint (.pptx). Plain text and Markdown are UTF-8 decoded as
 * is; HTML has its markup stripped; OOXML archives are unzipped and their text
 * runs flattened; PDFs are sent through Amazon Textract. Output is deterministic
 * for identical input bytes.
 *
 * @throws if `contentType` is unsupported or the underlying extraction fails.
 */
export async function extractText(
  bytes: Uint8Array,
  contentType: string,
  options: ExtractOptions = {},
): Promise<string> {
  const type = normalizeContentType(contentType);

  switch (type) {
    case CONTENT_TYPE.pdf:
      return extractTextFromPdf(bytes, options.pdf);
    case CONTENT_TYPE.plain:
    case CONTENT_TYPE.markdown:
      return decodeUtf8(bytes);
    case CONTENT_TYPE.html:
      return extractTextFromHtml(decodeUtf8(bytes));
    case CONTENT_TYPE.docx:
      return extractTextFromDocx(bytes);
    case CONTENT_TYPE.pptx:
      return extractTextFromPptx(bytes);
    default:
      // Be lenient with other text/* subtypes (e.g. text/x-markdown): treat
      // them as plain UTF-8. Everything else is an error.
      if (type.startsWith('text/')) {
        return decodeUtf8(bytes);
      }
      throw new Error(`Unsupported content type: ${contentType}`);
  }
}
