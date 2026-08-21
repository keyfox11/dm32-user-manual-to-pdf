#!/usr/bin/env node
/**
 * Mirror the DM32 user manual and every asset it needs into ./cache, laid out by
 * host + path so that render.mjs can resolve any URL to a local file.
 *
 * The HTML is stored byte-identical to upstream: all restructuring happens later,
 * in render.mjs's DOM pass. That keeps the mirror honest and re-verifiable.
 *
 *   node fetch-assets.mjs                 # images for chapters 1-3 (default range)
 *   node fetch-assets.mjs --from 1 --to 5
 *   node fetch-assets.mjs --all           # every image in the manual
 *   node fetch-assets.mjs --refresh       # re-download even if cached
 */

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, 'cache');

export const MANUAL_URL =
  'https://technical.swissmicros.com/dm32/doc/dm32_user_manual.html';

/** Stylesheets and fonts the page pulls from other hosts. */
const EXTERNAL_ASSETS = [
  'https://tech.swissmicros.com/User-Manuals/usermanuals.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css',
  // Referenced from within font-awesome.min.css; woff2 is the only format Chrome needs.
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2',
];

/** Map an absolute URL to its path inside ./cache. */
export function cachePathFor(url) {
  const u = new URL(url);
  // Drop query strings (font-awesome appends ?v=4.7.0) so the on-disk name is stable.
  return join(CACHE, u.host, ...u.pathname.split('/').filter(Boolean));
}

function parseArgs(argv) {
  const args = { from: 1, to: 3, all: false, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--from') args.from = Number(argv[++i]);
    else if (a === '--to') args.to = Number(argv[++i]);
  }
  return args;
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

const UA =
  'dm32-user-manual-to-pdf/1.0 (local documentation build)';
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * technical.swissmicros.com rate-limits bursts with 429, so back off and retry
 * rather than dropping the image. Honours Retry-After when the server sends it,
 * otherwise doubles the wait on each attempt.
 */
async function download(url, { refresh = false, attempt = 0 } = {}) {
  const dest = cachePathFor(url);
  if (!refresh && (await exists(dest))) return { dest, skipped: true };

  const res = await fetch(url, { headers: { 'User-Agent': UA } });

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_BACKOFF_MS * 2 ** attempt;
    await sleep(wait + Math.floor(Math.random() * 250));
    return download(url, { refresh, attempt: attempt + 1 });
  }

  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { dest, bytes: buf.length, skipped: false, retries: attempt };
}

/** Run `jobs` with bounded concurrency, returning results in order. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Split the manual body into its top-level `.sect1` chapters, in document order.
 * Asciidoctor emits one per numbered chapter, so index+1 is the chapter number.
 */
export function splitChapters(html) {
  const start = html.indexOf('<div id="content">');
  const body = start >= 0 ? html.slice(start) : html;
  const parts = body.split('<div class="sect1">');
  // parts[0] is the preamble / title block; the rest are chapters.
  return parts.slice(1).map((p, i) => {
    const m = /<h2 id="([^"]+)">([\s\S]*?)<\/h2>/.exec(p);
    return {
      number: i + 1,
      id: m?.[1] ?? `chapter-${i + 1}`,
      title: (m?.[2] ?? '').replace(/<[^>]+>/g, '').trim(),
      html: p,
    };
  });
}

/** Collect distinct <img src> values from a slab of HTML. */
export function imageSources(html) {
  return [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]))];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Mirroring DM32 user manual into ${CACHE}`);

  const manual = await download(MANUAL_URL, { refresh: args.refresh });
  console.log(
    `  manual   ${manual.skipped ? 'cached' : `${(manual.bytes / 1024).toFixed(0)} KB`}`,
  );
  const html = await readFile(manual.dest, 'utf8');

  for (const url of EXTERNAL_ASSETS) {
    const r = await download(url, { refresh: args.refresh });
    const name = url.split('/').pop();
    console.log(`  asset    ${name} ${r.skipped ? '(cached)' : `${(r.bytes / 1024).toFixed(0)} KB`}`);
  }

  const chapters = splitChapters(html);
  const selected = args.all
    ? chapters
    : chapters.filter((c) => c.number >= args.from && c.number <= args.to);

  if (!selected.length) {
    throw new Error(`No chapters matched --from ${args.from} --to ${args.to}`);
  }

  // The preamble sits before the first chapter and may carry images of its own.
  const scope = html.slice(0, html.indexOf('<div class="sect1">')) +
    selected.map((c) => c.html).join('');
  const srcs = imageSources(scope);

  console.log(
    `\nChapters ${args.all ? '1-' + chapters.length : `${args.from}-${args.to}`}: ` +
      `${selected.length} chapter(s), ${srcs.length} distinct images`,
  );
  for (const c of selected) console.log(`  ${c.title}`);

  const base = new URL(MANUAL_URL);
  let fetched = 0;
  let cached = 0;
  let retried = 0;
  const failures = [];

  // Three at a time, not eight: the origin 429s on heavier bursts.
  await pool(srcs, 3, async (src) => {
    const url = new URL(src, base).href;
    try {
      const r = await download(url, { refresh: args.refresh });
      if (r.skipped) cached++;
      else {
        fetched++;
        if (r.retries) retried++;
      }
    } catch (err) {
      failures.push(`${src}: ${err.message}`);
    }
  });

  console.log(`\nImages: ${fetched} downloaded, ${cached} already cached` + (retried ? `, ${retried} needed a retry` : ''));
  if (failures.length) {
    console.error(`\n${failures.length} image(s) FAILED:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  }

  // Retrieval date is printed on the generated title page.
  const stampPath = join(CACHE, 'fetched.json');
  const stamp = {
    source: MANUAL_URL,
    retrieved: new Date().toISOString().slice(0, 10),
    chapters: chapters.map((c) => ({ number: c.number, title: c.title })),
  };
  await writeFile(stampPath, JSON.stringify(stamp, null, 2));
  console.log(`\nWrote ${stampPath}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-assets.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
