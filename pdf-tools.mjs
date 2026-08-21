/**
 * Reading page positions back out of a rendered PDF, and stamping page numbers
 * onto it.
 *
 * Where a heading lands is only knowable after Chrome has paginated, so a table
 * of contents with real page numbers needs two passes: render once to find out,
 * then render again with the numbers filled in. Chrome already emits an outline
 * entry for every h1-h6 (that is the `outline: true` bookmark tree), and each
 * entry's destination names its page directly -- so the outline doubles as the
 * heading-to-page map and nothing extra has to be injected to measure it.
 */

import { PDFDocument, PDFName, PDFDict, StandardFonts, rgb } from 'pdf-lib';

/** Decode a PDF text string, which may be literal or hex, UTF-16BE or PDFDoc. */
function decodeTitle(obj) {
  if (!obj) return '';
  if (typeof obj.decodeText === 'function') return obj.decodeText();
  return obj.toString().replace(/^[(<]|[)>]$/g, '');
}

export async function load(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/**
 * Flatten the bookmark tree into document order, resolving each entry to a
 * zero-based page index.
 *
 * Pre-order traversal (self, children, next sibling) is document order for a
 * well-formed outline, which is what lets callers zip this against a list of
 * headings collected from the DOM instead of matching on title text.
 */
export function readOutline(doc) {
  const pageOfRef = new Map();
  doc.getPages().forEach((p, i) => pageOfRef.set(p.ref.toString(), i));

  const entries = [];
  const walk = (item, level) => {
    let node = item;
    while (node) {
      const dest = node.lookup(PDFName.of('Dest'));
      let page = null;
      if (dest && typeof dest.asArray === 'function') {
        page = pageOfRef.get(dest.asArray()[0]?.toString()) ?? null;
      }
      entries.push({ title: decodeTitle(node.get(PDFName.of('Title'))), level, page });

      const child = node.lookup(PDFName.of('First'));
      if (child instanceof PDFDict) walk(child, level + 1);

      const next = node.lookup(PDFName.of('Next'));
      node = next instanceof PDFDict ? next : null;
    }
  };

  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  const first = outlines instanceof PDFDict ? outlines.lookup(PDFName.of('First')) : null;
  if (first instanceof PDFDict) walk(first, 1);
  return entries;
}

const ROMAN = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

export function toRoman(n) {
  let out = '';
  let v = n;
  for (const [value, numeral] of ROMAN) {
    while (v >= value) {
      out += numeral;
      v -= value;
    }
  }
  return out;
}

/**
 * Draw page numbers into the bottom margin.
 *
 * Follows book convention rather than raw sheet position: the cover carries no
 * number, front matter (the contents) is numbered in lowercase roman, and the
 * body restarts at arabic 1 -- so the numbers in the table of contents are the
 * numbers a reader sees on the body pages.
 *
 * Done here rather than with Chrome's displayHeaderFooter because that template
 * is the same on every sheet and has no way to vary by page, so it cannot skip
 * the cover or switch numbering scheme partway through.
 */
export async function stampPageNumbers(doc, { coverPages = 1, frontMatterPages = 0, marginIn = 0.7 } = {}) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 9;
  const pages = doc.getPages();
  let stamped = 0;

  pages.forEach((page, i) => {
    if (i < coverPages) return; // cover stays clean

    const inFront = i < coverPages + frontMatterPages;
    const label = inFront
      ? toRoman(i - coverPages + 1)
      : String(i - coverPages - frontMatterPages + 1);

    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (width - textWidth) / 2,
      // Centred within the bottom margin band, clear of the text block.
      y: marginIn * 72 * 0.42,
      size,
      font,
      color: rgb(0.42, 0.42, 0.42),
    });
    stamped++;
  });

  return stamped;
}

export function pageCount(doc) {
  return doc.getPageCount();
}
