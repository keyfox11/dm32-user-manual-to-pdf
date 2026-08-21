/**
 * Locate an installed Chromium-based browser.
 *
 * puppeteer-core deliberately ships without bundling a browser, so this pipeline
 * drives whatever Chrome or Edge the machine already has -- no 150 MB download,
 * and the rendering engine is one the user can identify and update themselves.
 *
 * PUPPETEER_EXECUTABLE_PATH wins over everything, which is the escape hatch for
 * Chromium installed somewhere the list below does not guess (Snap, Flatpak,
 * Homebrew casks, a portable build).
 */

import { access } from 'node:fs/promises';
import { platform } from 'node:process';

const CANDIDATES = {
  // Forward slashes work on Windows too, and keep the list free of escapes.
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ],
};

/** Absolute path to a usable browser, or a message explaining how to name one. */
export async function findChrome() {
  const paths = [process.env.PUPPETEER_EXECUTABLE_PATH, ...(CANDIDATES[platform] ?? [])]
    .filter(Boolean);

  for (const p of paths) {
    try {
      await access(p);
      return p;
    } catch {
      /* keep looking */
    }
  }

  throw new Error(
    `No Chrome, Chromium or Edge found on ${platform}. Looked in:\n` +
      paths.map((p) => `  ${p}`).join('\n') +
      '\nSet PUPPETEER_EXECUTABLE_PATH to a Chromium-based browser and try again.',
  );
}
