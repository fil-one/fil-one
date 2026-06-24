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
 * A single entry decoded from a ZIP archive: its name and its decompressed
 * bytes.
 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
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
 * Decompress one entry's payload given its compression method.
 */
function decompress(method: number, payload: Buffer, name: string): Buffer {
  if (method === METHOD_STORED) {
    return payload;
  }
  if (method === METHOD_DEFLATED) {
    return inflateRawSync(payload);
  }
  throw new Error(`Unsupported ZIP compression method ${method} for entry "${name}"`);
}

/**
 * Read a single central-directory entry, returning the decoded entry and the
 * offset of the next central-directory record.
 */
function readCentralEntry(buffer: Buffer, offset: number): { entry: ZipEntry; next: number } {
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
  const payload = buffer.subarray(dataStart, dataStart + compressedSize);

  const data = decompress(compressionMethod, payload, name);
  const next = offset + 46 + nameLength + extraLength + commentLength;
  return { entry: { name, data: new Uint8Array(data) }, next };
}

/**
 * Parse a ZIP archive (e.g. an OOXML .docx/.pptx) into a map of entry name to
 * decompressed bytes. Only the STORED and DEFLATE methods are supported, which
 * covers everything the Office formats use.
 *
 * @throws if the buffer is not a valid ZIP archive or uses an unsupported
 *   compression method.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) {
    throw new Error('Malformed ZIP: end-of-central-directory record not found');
  }

  try {
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);

    const entries = new Map<string, Uint8Array>();
    for (let i = 0; i < entryCount; i++) {
      if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
        throw new Error('Malformed ZIP: bad central-directory header');
      }
      const { entry, next } = readCentralEntry(buffer, offset);
      entries.set(entry.name, entry.data);
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
