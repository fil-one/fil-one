// Maps object keys to the content types `@filone/rag-shared`'s `extractText`
// understands. The indexer enumerates objects with listObjects (no HeadObject),
// so a stored Content-Type is only available after GetObject — and is often a
// generic `application/octet-stream`. When the stored type is missing or
// generic we fall back to the file extension.

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Content types that carry no useful signal — always prefer the extension. */
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Resolve the content type to hand to `extractText` for `objectKey`.
 *
 * Prefers the S3-reported `storedContentType` when it is specific; otherwise
 * guesses from the key's file extension. Returns `undefined` when neither
 * yields a type the extractor can use, so callers can skip the object rather
 * than feed the extractor something it will reject.
 */
export function resolveContentType(
  objectKey: string,
  storedContentType?: string,
): string | undefined {
  const stored = storedContentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (stored && !GENERIC_CONTENT_TYPES.has(stored)) {
    return stored;
  }

  const lastDot = objectKey.lastIndexOf('.');
  if (lastDot === -1 || lastDot === objectKey.length - 1) {
    return undefined;
  }
  const extension = objectKey.slice(lastDot + 1).toLowerCase();
  return EXTENSION_CONTENT_TYPES[extension];
}
