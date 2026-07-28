import { getDocumentProxy } from 'unpdf';

/**
 * Largest document this extractor will parse. pdf.js holds per-document
 * structures (xref, page tree, fonts) for the whole file, so memory grows with
 * page count no matter how carefully pages are released: a 5000-page text
 * document measured at ~420 MB RSS, comfortably inside the worker's 1024 MB
 * budget. Beyond that we throw rather than risk an out-of-memory kill — an OOM
 * takes down the whole invocation, whereas a thrown error is caught per object
 * and counted as a single failure.
 */
const MAX_PAGES = 5000;

/**
 * The parts of a pdf.js text item this extractor reads. Declared locally
 * because unpdf's type declarations import their pdf.js types with
 * extensionless relative paths, which do not resolve under this workspace's
 * module resolution — `getTextContent()` therefore comes back untyped.
 */
interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

/**
 * Text content also carries marked-content markers, which have no `str`.
 */
function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null && 'str' in item;
}

/**
 * Extract text from a PDF entirely in-process using unpdf (a serverless build
 * of pdf.js with no worker file or native dependencies), so the bytes never
 * leave the Lambda — user buckets live on tenant storage that AWS document
 * services cannot read from.
 *
 * Line breaks within a page are preserved and pages are joined with a blank
 * line, feeding the chunker its preferred paragraph/line separators. A PDF
 * with no text layer (e.g. a scan) yields an empty string — there is no OCR,
 * and callers treat empty text as "nothing to index".
 *
 * Pages are read one at a time and released as we go. unpdf's own `extractText`
 * fans out over every page with `Promise.all` and never releases them, which
 * holds the entire document's text content in memory at once; since this build
 * of pdf.js has no worker thread that concurrency buys no speed, only peak
 * memory.
 *
 * @throws if the bytes are not a parseable PDF or the document exceeds
 *   {@link MAX_PAGES}.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  // pdf.js takes ownership of (and may detach) the buffer it is handed, so
  // give it a copy rather than the caller's bytes.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (pdf.numPages > MAX_PAGES) {
      throw new Error(`PDF has ${pdf.numPages} pages, exceeding the ${MAX_PAGES}-page limit`);
    }

    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content: { items: unknown[] } = await page.getTextContent();
        const text = content.items
          .filter(isTextItem)
          .map((item) => item.str + (item.hasEOL ? '\n' : ''))
          .join('')
          .trim();
        if (text.length > 0) pages.push(text);
      } finally {
        // Release this page's parsed content before moving on, so peak memory
        // stays flat across a long document instead of growing per page.
        page.cleanup();
      }
    }
    return pages.join('\n\n');
  } finally {
    await pdf.destroy();
  }
}
