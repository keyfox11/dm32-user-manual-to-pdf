#!/usr/bin/env node
/**
 * Rasterise pages of a rendered PDF to PNG so the pagination can be eyeballed.
 *
 * Uses Chrome's own PDF viewer rather than adding a native rasteriser (pdftoppm,
 * ImageMagick, canvas bindings) as a dependency -- the browser is already here.
 *
 *   node preview.mjs out/dm32_user_manual_ch1-3.pdf 1 8
 *   node preview.mjs out/dm32_user_manual_full.pdf 1 200 1.5 10   # every 10th page
 *
 * PNGs land in out/preview/.
 */

import { mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const pdfPath = process.argv[2] ?? join(ROOT, 'out', 'dm32_user_manual_ch1-3.pdf');
const first = Number(process.argv[3] ?? 1);
const last = Number(process.argv[4] ?? 6);
const scale = Number(process.argv[5] ?? 1.5);
const step = Number(process.argv[6] ?? 1); // sample every Nth page

const outDir = join(ROOT, 'out', 'preview');
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: await findChrome(),
  headless: true,
  args: ['--allow-file-access-from-files'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({
    width: Math.round(8.5 * 96 * scale),
    height: Math.round(11 * 96 * scale),
    deviceScaleFactor: 1,
  });

  const stem = basename(pdfPath, '.pdf');
  for (let n = first; n <= last; n += step) {
    // A bare #page= hash change does not make PDFium re-navigate, so reset first.
    await page.goto('about:blank');
    await page.goto(`${pathToFileURL(pdfPath).href}#page=${n}&toolbar=0&view=FitH`, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    // PDFium paints asynchronously and reports no load event of its own.
    await new Promise((r) => setTimeout(r, 2500));

    const file = join(outDir, `${stem}-p${String(n).padStart(3, '0')}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${file}`);
  }
} finally {
  await browser.close();
}
