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
 *
 * Failing that, a Chrome for Testing build sitting in ./chrome is used, so
 * someone with no system browser can run `npx @puppeteer/browsers install
 * chrome@stable` once and have every later build just work.
 */

import { access, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';

const ROOT = dirname(fileURLToPath(import.meta.url));

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

/* Where @puppeteer/browsers puts the executable inside each versioned folder.
   The folder itself is named <platform>-<version>, and the platform segment is
   the installer's own, not Node's: mac_arm, mac, win64, win32, linux. Several
   are listed per host because a machine can hold more than one -- an arm64 Mac
   happily runs an x64 build under Rosetta. */
const TESTING_BUILDS = {
  win32: ['chrome-win64/chrome.exe', 'chrome-win32/chrome.exe'],
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ],
  linux: ['chrome-linux64/chrome'],
};

/* "mac_arm-152.0.7977.64" -> [152, 0, 7977, 64]. Sorting these as strings puts
   99 above 152, which would pin the project to whatever old build is lying
   around after an upgrade. */
const versionOf = (dir) =>
  (dir.split('-').pop() ?? '').split('.').map(Number);

function newestFirst(a, b) {
  const [va, vb] = [versionOf(a), versionOf(b)];
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * Executables from a project-local `npx @puppeteer/browsers install` cache.
 * Newest version first. An absent or unreadable ./chrome is simply no candidates
 * -- not having run the installer is the normal case, not an error.
 */
async function localBuilds(root) {
  const base = join(root, 'chrome');
  let dirs;
  try {
    dirs = (await readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(newestFirst);
  } catch {
    return [];
  }
  return dirs.flatMap((d) =>
    (TESTING_BUILDS[platform] ?? []).map((rel) => join(base, d, rel)),
  );
}

/** Absolute path to a usable browser, or a message explaining how to name one. */
export async function findChrome(root = ROOT) {
  /* Project-local builds outrank the system ones. Installing a browser into the
     project is a deliberate act and usually a version someone pinned on purpose;
     a Chrome in /Applications is just there. */
  const paths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...(await localBuilds(root)),
    ...(CANDIDATES[platform] ?? []),
  ].filter(Boolean);

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
      '\nSet PUPPETEER_EXECUTABLE_PATH to a Chromium-based browser and try again.' +
      '\n\nIf you have no Chromium-based browser at all, install a standalone one\n' +
      'into this project and it will be found automatically:\n' +
      '  npx @puppeteer/browsers install chrome@stable',
  );
}
