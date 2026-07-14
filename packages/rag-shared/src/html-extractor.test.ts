import { describe, expect, it } from 'vitest';

import { extractTextFromHtml } from './html-extractor.js';

describe('extractTextFromHtml', () => {
  it('strips ordinary tags and keeps the text content', () => {
    const html = '<html><body><p>Hello <b>bold</b> world</p></body></html>';
    expect(extractTextFromHtml(html)).toBe('Hello bold world');
  });

  it('removes <script> blocks and their contents', () => {
    const html = '<p>before</p><script>alert("x"); var y = 1 < 2;</script><p>after</p>';
    expect(extractTextFromHtml(html)).toBe('before after');
  });

  it('removes <style> blocks and their contents', () => {
    const html = '<style>.c { color: red; }</style><p>visible</p>';
    expect(extractTextFromHtml(html)).toBe('visible');
  });

  it('removes HTML comments', () => {
    const html = '<p>keep</p><!-- secret <p>not real</p> --><p>this</p>';
    expect(extractTextFromHtml(html)).toBe('keep this');
  });

  it('decodes named entities', () => {
    const html = '<p>a &amp; b &lt; c &gt; d &quot;e&quot; &nbsp; f</p>';
    expect(extractTextFromHtml(html)).toBe('a & b < c > d "e" f');
  });

  it('decodes numeric and hex character references', () => {
    const html = '<p>&#65;&#66;&#67; &#x44;&#x45;</p>';
    expect(extractTextFromHtml(html)).toBe('ABC DE');
  });

  it('replaces out-of-range or invalid numeric references with U+FFFD instead of throwing', () => {
    expect(() => extractTextFromHtml('<p>&#x110000;</p>')).not.toThrow();
    expect(extractTextFromHtml('<p>a&#x110000;b</p>')).toBe('a�b'); // > U+10FFFF
    expect(extractTextFromHtml('<p>a&#9999999999;b</p>')).toBe('a�b'); // overflow
    expect(extractTextFromHtml('<p>a&#xD800;b</p>')).toBe('a�b'); // lone surrogate
    expect(extractTextFromHtml('<p>a&#0;b</p>')).toBe('a�b'); // null character
  });

  it('inserts breaks for block-level boundaries so words do not run together', () => {
    const html = '<div>one</div><div>two</div><br>three';
    expect(extractTextFromHtml(html)).toBe('one two three');
  });

  it('collapses whitespace runs and trims the ends', () => {
    const html = '  <p>  lots   of \n\n  space  </p>  ';
    expect(extractTextFromHtml(html)).toBe('lots of space');
  });

  it('is deterministic across repeated calls', () => {
    const html = '<div><script>x</script><p>Deterministic &amp; stable</p><br>line2</div>';
    const a = extractTextFromHtml(html);
    const b = extractTextFromHtml(html);
    expect(a).toBe(b);
    expect(a).toBe('Deterministic & stable line2');
  });

  it('handles an empty or markup-only document', () => {
    expect(extractTextFromHtml('')).toBe('');
    expect(extractTextFromHtml('<br><hr><img src="x">')).toBe('');
  });
});
