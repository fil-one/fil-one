/**
 * Deterministic palette index from a string, so an org's monogram color is
 * stable across renders and sessions without storing it anywhere. FNV-1a
 * rather than a simpler sum-of-char-codes hash: two names that are
 * permutations of each other (e.g. "Acme Labs" vs "Labs Acme") land on
 * different indices instead of colliding.
 */
export function hashToPaletteIndex(input: string, paletteSize: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % paletteSize;
}
