import { DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP_SIZE } from './constants.js';

/**
 * Options accepted by {@link chunk}.
 */
export interface ChunkingOptions {
  /** Target chunk size in characters. Defaults to {@link DEFAULT_CHUNK_SIZE}. */
  chunkSize?: number;
  /** Overlap in characters carried between consecutive chunks. Defaults to {@link DEFAULT_OVERLAP_SIZE}. */
  overlapSize?: number;
}

/**
 * Separators tried in descending order of preference when a piece of text is
 * still larger than the target chunk size. Splitting on a paragraph break is
 * preferred over a line break, which is preferred over a sentence boundary, and
 * finally a word boundary. The empty string is the last resort and splits the
 * text character-by-character so an extremely long token can never wedge the
 * splitter.
 */
const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''] as const;

/**
 * Collapse every run of whitespace (spaces, tabs, newlines) to a single space
 * and trim the ends. Applied to every emitted chunk so that re-indexing
 * identical bytes always yields byte-identical chunks regardless of the
 * incidental whitespace in the source.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Hard-split `text` into fixed-size pieces of up to `chunkSize` characters.
 * Used as the last resort by {@link splitToPieces} when no separator can keep
 * an oversized token within the target size.
 */
function hardSplit(text: string, chunkSize: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    pieces.push(text.slice(i, i + chunkSize));
  }
  return pieces;
}

/**
 * Split `text` on `separator`, re-attaching the separator to every segment but
 * the last so no characters are dropped, and discarding empty segments.
 */
function segmentsWithSeparator(text: string, separator: string): string[] {
  const raw = text.split(separator);
  return raw
    .map((segment, index) => (index < raw.length - 1 ? segment + separator : segment))
    .filter((segment) => segment.length > 0);
}

function splitToPieces(text: string, chunkSize: number, separators: readonly string[]): string[] {
  if (text.length <= chunkSize) {
    return text.length === 0 ? [] : [text];
  }

  const [separator, ...rest] = separators;
  // The empty-string separator (or an exhausted list) is the last resort: hard
  // split by character so an oversized token can never wedge the splitter.
  if (separator === undefined || separator === '') {
    return hardSplit(text, chunkSize);
  }

  const pieces: string[] = [];
  for (const segment of segmentsWithSeparator(text, separator)) {
    if (segment.length <= chunkSize) {
      pieces.push(segment);
    } else {
      pieces.push(...splitToPieces(segment, chunkSize, rest));
    }
  }
  return pieces;
}

/**
 * Greedily merge `pieces` into chunks of up to `chunkSize` characters, carrying
 * `overlapSize` characters of trailing context from each emitted chunk into the
 * next.
 */
function mergePieces(pieces: string[], chunkSize: number, overlapSize: number): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    const normalized = normalizeWhitespace(current);
    if (normalized.length > 0) {
      chunks.push(normalized);
    }
  };

  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
      continue;
    }
    if (current.length + piece.length <= chunkSize) {
      current += piece;
      continue;
    }
    flush();
    // Seed the next chunk with the tail of the one we just emitted so adjacent
    // chunks share context. Cap the carried overlap so `overlap + piece` never
    // exceeds chunkSize (a piece may itself be as large as chunkSize).
    const room = Math.max(0, chunkSize - piece.length);
    const carry = Math.min(overlapSize, room);
    const overlap = carry > 0 ? current.slice(current.length - carry) : '';
    current = overlap + piece;
  }
  flush();

  return chunks;
}

/**
 * Split `text` into overlapping chunks suitable for embedding and retrieval.
 *
 * Uses recursive character splitting: the text is broken on the largest
 * structural separator that yields pieces within `chunkSize` (paragraph, then
 * line, then sentence, then word, finally character), and the pieces are merged
 * back up to the target size with `overlapSize` characters of overlap between
 * neighbours. Every chunk has its whitespace normalized (runs collapsed to a
 * single space, ends trimmed), so identical input always produces identical
 * output.
 *
 * @throws if `text` is empty/whitespace-only, if `chunkSize` is not positive,
 *   or if `overlapSize` is negative or not smaller than `chunkSize`.
 */
export function chunk(text: string, options?: ChunkingOptions): string[] {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlapSize = options?.overlapSize ?? DEFAULT_OVERLAP_SIZE;

  if (chunkSize <= 0) {
    throw new Error('chunkSize must be a positive number');
  }
  if (overlapSize < 0) {
    throw new Error('overlapSize cannot be negative');
  }
  if (overlapSize >= chunkSize) {
    throw new Error('overlapSize must be smaller than chunkSize');
  }
  if (!text || text.trim().length === 0) {
    throw new Error('Text to chunk cannot be empty');
  }

  const pieces = splitToPieces(text, chunkSize, SEPARATORS);
  return mergePieces(pieces, chunkSize, overlapSize);
}
