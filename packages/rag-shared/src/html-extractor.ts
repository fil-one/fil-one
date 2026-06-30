/**
 * The minimal set of named HTML entities we decode. Numeric character
 * references (`&#160;`, `&#xA0;`) are handled separately. We intentionally keep
 * this list small and explicit rather than pulling in an external entity
 * library, which keeps the output deterministic and dependency-free.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Convert a numeric character-reference value to a string, never throwing.
 * Out-of-range values (negative, > U+10FFFF), the null character, and lone
 * surrogates are not valid Unicode scalar values, so — following the HTML
 * spec's handling of malformed numeric references — they decode to the
 * replacement character U+FFFD rather than crashing `String.fromCodePoint`.
 */
function decodeCodePoint(code: number): string {
  if (
    !Number.isInteger(code) ||
    code <= 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return '�';
  }
  return String.fromCodePoint(code);
}

/**
 * Decode the named and numeric HTML entities we support. `&amp;` is decoded
 * last via the named map, so a literal `&amp;lt;` decodes to `&lt;` (single
 * pass, no double-decoding).
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : decodeCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : decodeCodePoint(code);
    }
    const replacement = NAMED_ENTITIES[body.toLowerCase()];
    return replacement ?? match;
  });
}

/**
 * Extract the readable text from an HTML document.
 *
 * `<script>`, `<style>`, and comment content is dropped entirely; every other
 * tag is stripped, block-level boundaries are turned into whitespace, named and
 * numeric entities are decoded, and whitespace is collapsed. The transformation
 * is a single deterministic pass so identical input always yields identical
 * output.
 */
export function extractTextFromHtml(html: string): string {
  const withoutScripts = html
    // Drop comments first so an unclosed tag inside a comment cannot leak.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Drop <script>...</script> and <style>...</style> including their content.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');

  const withBlockBreaks = withoutScripts
    // Turn block-level closings and breaks into newlines so words on either
    // side do not run together once tags are removed.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const withoutTags = withBlockBreaks.replace(/<[^>]*>/g, ' ');

  const decoded = decodeEntities(withoutTags);

  return decoded.replace(/\s+/g, ' ').trim();
}
