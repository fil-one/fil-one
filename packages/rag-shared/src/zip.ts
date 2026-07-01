import { inflateRawSync } from 'node:zlib';

/**
 * Signatures for the ZIP structures we read. We parse the central directory
 * (authoritative) rather than streaming local headers, which keeps the reader
 * simple and robust to data descriptors.
 */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/**
 * Decompression limits, sized for the 512 MB worker Lambda. Peak memory for a
 * read part is roughly the inflated bytes plus its UTF-16 string (~2x) plus
 * parser overhead, and only the parts an extractor actually reads are inflated.
 * These are deliberately generous for real Office documents while bounding the
 * blast radius of a ZIP-bomb.
 */
const MAX_ENTRY_OUTPUT = 32 * 1024 * 1024; // 32 MB per decompressed entry
const MAX_TOTAL_OUTPUT = 64 * 1024 * 1024; // 64 MB aggregate across a single readZip

/**
 * Options for {@link readZip}. The defaults apply in production; tests override
 * them with tiny caps so a bomb fixture can trip a limit without allocating
 * large buffers.
 */
export interface ReadZipOptions {
  maxEntryOutput?: number;
  maxTotalOutput?: number;
}

/**
 * Shared decompression budget threaded through every entry's lazy thunk so the
 * per-entry cap and the aggregate cap are both enforced across however many
 * entries an extractor ends up reading.
 */
interface DecompressBudget {
  perEntry: number;
  total: number;
  remaining: number;
}

/**
 * The parsed (but not yet decompressed) location of a central-directory entry:
 * its name, compression method, and the still-compressed payload slice.
 */
interface CentralEntry {
  name: string;
  method: number;
  payload: Buffer;
  next: number;
}

/**
 * Locate the End Of Central Directory record by scanning backwards from the end
 * of the buffer. We bound the scan to the maximum possible comment length
 * (0xffff) plus the record size.
 */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      return i;
    }
  }
  return -1;
}

/**
 * Decompress one entry's payload given its compression method, bounding the
 * output against the shared budget. A DEFLATE entry is capped per-entry via
 * `maxOutputLength` (zlib throws `ERR_BUFFER_TOO_LARGE` before allocating the
 * full output) and then charged against the aggregate budget. A STORED entry is
 * uncompressed, so its payload length is the output size; that length comes from
 * the attacker-controlled compressedSize header, so it is charged against the
 * same per-entry and aggregate caps before the (uncopied) view is returned.
 */
function decompress(
  method: number,
  payload: Buffer,
  name: string,
  budget: DecompressBudget,
): Uint8Array {
  if (method === METHOD_STORED) {
    // STORED is uncompressed: the payload length IS the output size, and it
    // derives from the attacker-controlled compressedSize header. Charge it
    // against both caps exactly like a DEFLATE entry.
    if (payload.length > budget.perEntry) {
      throw new Error(
        `ZIP entry "${name}" exceeds the ${budget.perEntry}-byte decompression limit`,
      );
    }
    if (payload.length > budget.remaining) {
      throw new Error(`ZIP archive exceeds the ${budget.total}-byte aggregate decompression limit`);
    }
    budget.remaining -= payload.length;
    return payload;
  }
  if (method === METHOD_DEFLATED) {
    let data: Buffer;
    try {
      data = inflateRawSync(payload, { maxOutputLength: budget.perEntry });
    } catch (error) {
      if (error instanceof RangeError) {
        throw new Error(
          `ZIP entry "${name}" exceeds the ${budget.perEntry}-byte decompression limit`,
        );
      }
      throw error;
    }
    if (data.length > budget.remaining) {
      throw new Error(`ZIP archive exceeds the ${budget.total}-byte aggregate decompression limit`);
    }
    budget.remaining -= data.length;
    return data;
  }
  throw new Error(`Unsupported ZIP compression method ${method} for entry "${name}"`);
}

/**
 * Read a single central-directory entry, returning its name, compression
 * method, and the still-compressed payload slice, plus the offset of the next
 * central-directory record. Decompression is deferred to a lazy thunk in
 * {@link readZip} so unreferenced entries are never inflated.
 */
function readCentralEntry(buffer: Buffer, offset: number): CentralEntry {
  const compressionMethod = buffer.readUInt16LE(offset + 10);
  const compressedSize = buffer.readUInt32LE(offset + 20);
  const nameLength = buffer.readUInt16LE(offset + 28);
  const extraLength = buffer.readUInt16LE(offset + 30);
  const commentLength = buffer.readUInt16LE(offset + 32);
  const localHeaderOffset = buffer.readUInt32LE(offset + 42);
  const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Malformed ZIP: bad local header for entry "${name}"`);
  }
  // The local header's name/extra lengths can differ from the central
  // directory's, so read them from the local header to find the payload.
  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
  // subarray clamps out-of-range bounds silently, so a truncated archive would
  // yield a short payload (and, for STORED entries, partial extraction) instead
  // of an error. Validate the slice lies fully within the buffer first.
  if (dataStart + compressedSize > buffer.length) {
    throw new Error(`Malformed ZIP: truncated payload for entry "${name}"`);
  }
  const payload = buffer.subarray(dataStart, dataStart + compressedSize);

  const next = offset + 46 + nameLength + extraLength + commentLength;
  return { name, method: compressionMethod, payload, next };
}

/**
 * Parse a ZIP archive (e.g. an OOXML .docx/.pptx) into a map of entry name to a
 * lazy thunk that decompresses that entry on demand. Only the STORED and
 * DEFLATE methods are supported, which covers everything the Office formats
 * use.
 *
 * Decompression is deferred so that an archive padded with many entries (the
 * central directory holds up to 65,535) costs nothing for the entries an
 * extractor never reads. Each thunk bounds its output against {@link
 * ReadZipOptions.maxEntryOutput} and a shared aggregate budget
 * ({@link ReadZipOptions.maxTotalOutput}), so a ZIP-bomb fails fast with a
 * clear error rather than exhausting memory.
 *
 * @throws if the buffer is not a valid ZIP archive. A thunk additionally throws
 *   when its entry uses an unsupported compression method or exceeds a
 *   decompression limit.
 */
export function readZip(
  bytes: Uint8Array,
  options: ReadZipOptions = {},
): Map<string, () => Uint8Array> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) {
    throw new Error('Malformed ZIP: end-of-central-directory record not found');
  }

  const total = options.maxTotalOutput ?? MAX_TOTAL_OUTPUT;
  const budget: DecompressBudget = {
    perEntry: options.maxEntryOutput ?? MAX_ENTRY_OUTPUT,
    total,
    remaining: total,
  };

  try {
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);

    const entries = new Map<string, () => Uint8Array>();
    for (let i = 0; i < entryCount; i++) {
      if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
        throw new Error('Malformed ZIP: bad central-directory header');
      }
      const { name, method, payload, next } = readCentralEntry(buffer, offset);
      entries.set(name, () => decompress(method, payload, name, budget));
      offset = next;
    }

    return entries;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error('Malformed ZIP: truncated archive or invalid offsets');
    }
    throw error;
  }
}
