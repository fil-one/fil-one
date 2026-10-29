/**
 * What the object page can show inline for an object. `null` means no preview:
 * the page offers the download instead.
 */
export type PreviewKind = 'image' | 'video' | 'audio' | 'text';

/**
 * The largest object of each kind the page loads on sight. Video and audio are
 * absent: the player streams them on demand and fetches only metadata until the
 * user presses play. An image or text file is fetched whole as soon as the page
 * opens, which counts toward egress, so these stay small.
 */
// Decimal, as `formatBytes` is, so the limit the placeholder states is a round number.
export const PREVIEW_SIZE_LIMITS: Record<'image' | 'text', number> = {
  image: 20_000_000,
  text: 1_000_000,
};

/** The characters of a text file the preview renders; the rest is a download away. */
export const TEXT_PREVIEW_MAX_CHARS = 20_000;

// Text types outside `text/*` that are still readable as plain text
const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/x-ndjson',
  'application/javascript',
  'application/toml',
]);

// The extensions a browser-uploaded object is likely to carry with a generic
// content type (`application/octet-stream`, or none at all)
const EXTENSION_KINDS: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  txt: 'text',
  md: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  ndjson: 'text',
  jsonl: 'text',
  yaml: 'text',
  yml: 'text',
  toml: 'text',
  xml: 'text',
  log: 'text',
};

function getKindFromContentType(contentType: string): PreviewKind | null {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  // HTML is shown as its source, never rendered: a page from a bucket must not run in the console
  if (mime.startsWith('text/') || TEXT_CONTENT_TYPES.has(mime) || mime.endsWith('+json')) {
    return 'text';
  }
  return null;
}

/** The final path segment of an object key: its file name. */
export function getObjectFileName(key: string): string {
  return key.split('/').at(-1) || key;
}

/** Each folder above the object, as the bucket listing's prefix for it, outermost first. */
export function getFolderPrefixes(objectKey: string): { name: string; prefix: string }[] {
  const segments = objectKey.split('/').slice(0, -1);
  return segments.map((name, index) => ({
    name,
    prefix: `${segments.slice(0, index + 1).join('/')}/`,
  }));
}

// The characters a shortened name keeps from its end: enough for the extension
// and the tail of an ID, which is what tells similar names apart
const SHORT_NAME_TAIL = 12;

/**
 * A file name cut to `maxLength` characters in the middle, as Finder does, so it
 * keeps both its recognisable start and its extension: `a_brilliant_clean_b…5500b_0.png`.
 */
export function shortenFileName(name: string, maxLength = 32): string {
  if (name.length <= maxLength) return name;
  const head = name.slice(0, maxLength - SHORT_NAME_TAIL - 1);
  return `${head}\u2026${name.slice(-SHORT_NAME_TAIL)}`;
}

/**
 * How to preview an object, from its content type, or from its file extension
 * when the content type says nothing useful.
 */
export function getPreviewKind(key: string, contentType?: string): PreviewKind | null {
  const fromType = contentType ? getKindFromContentType(contentType) : null;
  if (fromType) return fromType;
  const extension = getObjectFileName(key).split('.').at(-1)?.toLowerCase();
  return extension ? (EXTENSION_KINDS[extension] ?? null) : null;
}

/** Whether an object of this kind and size is small enough to load on sight. */
export function isWithinPreviewLimit(kind: PreviewKind, sizeBytes: number): boolean {
  if (kind === 'image' || kind === 'text') return sizeBytes <= PREVIEW_SIZE_LIMITS[kind];
  return true;
}

// Names for types whose MIME subtype does not read as a word on its own
const TYPE_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG image',
  'image/svg+xml': 'SVG image',
  'audio/mpeg': 'MP3 audio',
  'video/quicktime': 'QuickTime video',
  'text/plain': 'Plain text',
  'text/csv': 'CSV',
  'text/html': 'HTML',
  'text/markdown': 'Markdown',
  'application/json': 'JSON',
  'application/pdf': 'PDF document',
  'application/zip': 'ZIP archive',
  'application/gzip': 'Gzip archive',
  'application/x-tar': 'Tar archive',
  'application/octet-stream': 'Binary file',
};

const MEDIA_CATEGORIES: Record<string, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

/**
 * A content type as a person would say it: `image/png` is "PNG image". A type
 * with no friendlier name comes back as it is, so nothing is ever hidden.
 */
export function getFileTypeLabel(contentType: string): string {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const known = TYPE_LABELS[mime];
  if (known) return known;
  const [category, subtype] = mime.split('/');
  const noun = MEDIA_CATEGORIES[category];
  // "x-" marks an unregistered subtype; the rest of it is still its name
  return noun && subtype ? `${subtype.replace(/^x-/, '').toUpperCase()} ${noun}` : contentType;
}
