import { describe, expect, it } from 'vitest';

import { buildZip } from './test-fixtures.js';
import { readZip } from './zip.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * A bomb entry: `size` uncompressed bytes (zeros) that DEFLATE to a tiny
 * payload. Passed as raw bytes so the fixture's uncompressed size is large
 * while the archive stays small.
 */
const bomb = (size: number): Uint8Array => new Uint8Array(size);

describe('readZip', () => {
  it('round-trips entry contents through the lazy thunk', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'alpha' },
      { name: 'b.txt', data: 'beta', store: true },
    ]);
    const entries = readZip(zip);

    expect(decode(entries.get('a.txt')!())).toBe('alpha');
    expect(decode(entries.get('b.txt')!())).toBe('beta');
  });

  it('throws on bytes that are not a ZIP archive', () => {
    expect(() => readZip(new TextEncoder().encode('not a zip'))).toThrow(/Malformed ZIP/);
  });

  describe('ZIP-bomb defenses', () => {
    it('rejects an entry that exceeds the per-entry decompression limit', () => {
      const zip = buildZip([{ name: 'bomb', data: bomb(64 * 1024) }]);
      const entries = readZip(zip, { maxEntryOutput: 1024 });

      expect(() => entries.get('bomb')!()).toThrow(/exceeds the 1024-byte decompression limit/);
    });

    it('rejects entries that together exceed the aggregate decompression limit', () => {
      const zip = buildZip([
        { name: 'one', data: bomb(4096) },
        { name: 'two', data: bomb(4096) },
      ]);
      // Each entry fits under the per-entry cap; together they blow the aggregate.
      const entries = readZip(zip, { maxEntryOutput: 8192, maxTotalOutput: 6000 });

      expect(entries.get('one')!()).toHaveLength(4096); // first inflate succeeds
      expect(() => entries.get('two')!()).toThrow(/aggregate decompression limit/);
    });

    it('does not inflate entries that are never read (lazy decompression)', () => {
      const zip = buildZip([
        { name: 'word/document.xml', data: 'small' },
        { name: 'bomb', data: bomb(64 * 1024) },
      ]);
      // A tiny per-entry cap that the bomb would trip *if* it were inflated.
      // Parsing must not throw, proving the bomb's thunk was never invoked.
      const entries = readZip(zip, { maxEntryOutput: 1024 });

      expect(decode(entries.get('word/document.xml')!())).toBe('small');
      // The bomb only fails when its thunk is explicitly invoked.
      expect(() => entries.get('bomb')!()).toThrow(/decompression limit/);
    });
  });
});
