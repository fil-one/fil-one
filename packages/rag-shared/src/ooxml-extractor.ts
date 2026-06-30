import { XMLParser } from 'fast-xml-parser';

import { readZip } from './zip.js';

/**
 * In `preserveOrder` mode fast-xml-parser yields an ordered array of nodes,
 * where each node is a single-key object: either a tag mapping to its ordered
 * children (`{ "w:p": [...] }`) or a text node (`{ "#text": "..." }`).
 */
type OoxmlNode = Record<string, unknown>;

/**
 * Shared parser configuration. `preserveOrder` keeps document order (so text
 * runs and slides come out in reading order); `trimValues: false` keeps
 * significant whitespace inside `<w:t xml:space="preserve">` runs.
 */
const parser = new XMLParser({
  ignoreAttributes: true,
  preserveOrder: true,
  trimValues: false,
  processEntities: true,
});

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * The tag names that, regardless of XML namespace prefix, map onto structural
 * boundaries we honour when flattening a run tree to text.
 */
const TEXT_TAG = 't'; // <w:t> / <a:t>
const TAB_TAG = 'tab'; // <w:tab> / <a:tab>
const BREAK_TAG = 'br'; // <w:br> / <a:br>
const PARAGRAPH_TAG = 'p'; // <w:p> / <a:p>

/**
 * Strip the namespace prefix from a tag name (`w:p` -> `p`) so the walker can
 * treat Word and PowerPoint markup uniformly.
 */
function localName(tag: string): string {
  const colon = tag.indexOf(':');
  return colon === -1 ? tag : tag.slice(colon + 1);
}

/**
 * Recursively walk an ordered node list, appending extracted text to `parts`.
 * Tabs become `\t`, breaks become `\n`, and each paragraph is terminated with a
 * `\n` so paragraph boundaries survive into the flattened output.
 */
function walk(nodes: OoxmlNode[], parts: string[]): void {
  for (const node of nodes) {
    const tag = Object.keys(node).find((key) => key !== ':@');
    if (tag === undefined) {
      continue;
    }
    if (tag === '#text') {
      const value = node['#text'];
      if (typeof value === 'string') {
        parts.push(value);
      } else if (typeof value === 'number') {
        parts.push(String(value));
      }
      continue;
    }

    const children = node[tag];
    const childNodes = Array.isArray(children) ? (children as OoxmlNode[]) : [];
    switch (localName(tag)) {
      case TAB_TAG:
        parts.push('\t');
        break;
      case BREAK_TAG:
        parts.push('\n');
        break;
      case TEXT_TAG:
        walk(childNodes, parts);
        break;
      case PARAGRAPH_TAG:
        walk(childNodes, parts);
        parts.push('\n');
        break;
      default:
        walk(childNodes, parts);
    }
  }
}

/**
 * Parse one OOXML part (UTF-8 XML) into flattened text honouring tab, break,
 * and paragraph boundaries.
 */
function extractPartText(xmlBytes: Uint8Array): string {
  const xml = TEXT_DECODER.decode(xmlBytes);
  const parsed = parser.parse(xml) as OoxmlNode[];
  const parts: string[] = [];
  walk(parsed, parts);
  return parts.join('');
}

/**
 * Extract readable text from a Word (.docx) document. Reads `word/document.xml`
 * and flattens its `<w:t>` runs, preserving tab/line-break/paragraph
 * boundaries.
 *
 * @throws if the archive is malformed or lacks a main document part.
 */
export function extractTextFromDocx(bytes: Uint8Array): string {
  const entries = readZip(bytes);
  const document = entries.get('word/document.xml');
  if (!document) {
    throw new Error('Malformed DOCX: missing word/document.xml');
  }
  return extractPartText(document())
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Compare two slide part names by their numeric index so `slide2.xml` sorts
 * before `slide10.xml` rather than lexicographically. Non-numeric names fall
 * back to a stable lexicographic comparison.
 */
function compareSlideNames(a: string, b: string): number {
  const indexA = slideIndex(a);
  const indexB = slideIndex(b);
  if (indexA !== indexB) {
    return indexA - indexB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extract the numeric portion of a slide file name (`ppt/slides/slide10.xml`
 * -> 10). Returns {@link Number.MAX_SAFE_INTEGER} when no number is present so
 * such parts sort last deterministically.
 */
function slideIndex(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number.parseInt(match[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

/**
 * Extract readable text from a PowerPoint (.pptx) deck. Reads every
 * `ppt/slides/slideN.xml`, orders them by numeric natural sort (so slide2 comes
 * before slide10), and flattens each slide's `<a:t>` runs.
 *
 * @throws if the archive is malformed or contains no slides.
 */
export function extractTextFromPptx(bytes: Uint8Array): string {
  const entries = readZip(bytes);
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(compareSlideNames);

  if (slideNames.length === 0) {
    throw new Error('Malformed PPTX: no slides found under ppt/slides/');
  }

  const slides = slideNames.map((name) => extractPartText(entries.get(name)!()).trim());
  return slides
    .filter((slide) => slide.length > 0)
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
