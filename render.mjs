#!/usr/bin/env node
/**
 * Render the mirrored DM32 user manual to a typeset US Letter PDF.
 *
 * Drives the locally installed Chrome through puppeteer-core. The page is loaded
 * from ./cache over file://, every off-disk request is blocked, and the site's
 * stylesheets are injected from the mirror instead -- so a render is hermetic and
 * reproducible, and the injected print.css is guaranteed to come last in cascade
 * order.
 *
 *   node render.mjs                        # the complete manual (default)
 *   node render.mjs --to 3                 # just the first three chapters
 *   node render.mjs --from 4 --to 6
 *   node render.mjs --image-width 3.2      # narrow figures to save pages
 *   node render.mjs --dump-html            # also write the transformed HTML
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';
import { MANUAL_URL, cachePathFor } from './fetch-assets.mjs';
import { load, readOutline, stampPageNumbers, pageCount } from './pdf-tools.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, 'cache');
const OUT = join(ROOT, 'out');

const SITE_CSS = 'https://tech.swissmicros.com/User-Manuals/usermanuals.css';
const FA_CSS =
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css';
const FA_FONT =
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2';

/* The manual typesets its maths with MathJax, loaded from cdnjs and configured
   for AsciiMath with backslash-dollar delimiters. Requests for that tree are
   served out of the local npm package instead, so the render stays hermetic and
   the version stays pinned to whatever package.json says. */
const MATHJAX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/';
const MATHJAX_DIR = join(ROOT, 'node_modules', 'mathjax');

const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const mimeFor = (f) => MIME[extname(f).toLowerCase()] ?? 'application/octet-stream';

const verdict = (enabled, wrong) =>
  !enabled ? 'n/a (no contents)' : wrong === 0 ? 'all correct' : `${wrong} WRONG`;

/* Matching the viewport to the print content box makes the measurement pass see
   the same geometry Chrome will use when it paginates. */
function liveArea(marginIn) {
  return {
    width: Math.round((8.5 - 2 * marginIn) * 96),
    height: Math.round((11 - 2 * marginIn) * 96),
  };
}

function parseArgs(argv) {
  const a = {
    /* null means unbounded, so the default -- neither flag given -- is the whole
       manual. Someone who just wants the PDF should not have to ask for it. */
    from: null,
    to: null,
    out: null,
    imageWidth: 3.6, // inches
    dpiFloor: 220, // never enlarge an image past this effective resolution
    keepWholeRatio: 0.45, // of live page height
    weldRatio: 0.25, // widow-weld only when the dragged pair is under this
    baseFont: 10, // pt; print.css is authored around this
    margin: 0.7, // in
    shiftBlue: null, // override .bl; source #97B6E6, print.css uses #4A82D6
    toc: true, // generate a contents section with real page numbers
    tocDepth: 2, // 1 = chapters, 2 = + sections, 3 = + subsections
    pageNumbers: true, // stamp numbers into the bottom margin
    dumpHtml: false,
  };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    // --all is what you already get by default; kept so it is not an error to say so.
    if (k === '--all') (a.from = null), (a.to = null);
    else if (k === '--dump-html') a.dumpHtml = true;
    else if (k === '--from') a.from = Number(argv[++i]);
    else if (k === '--to') a.to = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--image-width') a.imageWidth = Number(argv[++i]);
    else if (k === '--dpi-floor') a.dpiFloor = Number(argv[++i]);
    else if (k === '--keep-whole-ratio') a.keepWholeRatio = Number(argv[++i]);
    else if (k === '--weld-ratio') a.weldRatio = Number(argv[++i]);
    else if (k === '--base-font') a.baseFont = Number(argv[++i]);
    else if (k === '--margin') a.margin = Number(argv[++i]);
    else if (k === '--shift-blue') a.shiftBlue = argv[++i];
    else if (k === '--no-toc') a.toc = false;
    else if (k === '--toc-depth') a.tocDepth = Number(argv[++i]);
    else if (k === '--no-page-numbers') a.pageNumbers = false;
    else unknown.push(k);
  }
  /* Refuse rather than ignore. With this many flags a typo is easy, and silently
     dropping one produces a plausible-looking PDF built to the wrong settings --
     the worst kind of wrong, because nothing about the output says so. */
  if (unknown.length) {
    const err = new Error(
      `Unrecognised option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}\n` +
        'See the Options section of README.md for the full list.',
    );
    err.usage = true; // a typo, not a crash -- print it without a stack trace
    throw err;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = await findChrome();
  const VIEWPORT = liveArea(args.margin);

  const manualPath = cachePathFor(MANUAL_URL);
  const [siteCss, faCssRaw, faFont, printCss, stampRaw] = await Promise.all([
    readFile(cachePathFor(SITE_CSS), 'utf8'),
    readFile(cachePathFor(FA_CSS), 'utf8'),
    readFile(cachePathFor(FA_FONT)),
    readFile(join(ROOT, 'print.css'), 'utf8'),
    readFile(join(CACHE, 'fetched.json'), 'utf8').catch(() => '{}'),
  ]).catch((err) => {
    throw new Error(`Cache incomplete -- run "node fetch-assets.mjs" first.\n  ${err.message}`);
  });
  const stamp = JSON.parse(stampRaw);

  /* Inline the Font Awesome webfont so the admonition icons need no network and
     no CORS negotiation from a file:// document. The upstream @font-face carries
     two `src:` declarations (an .eot shim followed by the real list), so the whole
     block has to go -- patching one of them leaves the other overriding it. */
  const faCss = faCssRaw.replace(
    /@font-face\s*\{[^}]*\}/,
    `@font-face{font-family:'FontAwesome';` +
      `src:url(data:font/woff2;base64,${faFont.toString('base64')}) format('woff2');` +
      `font-weight:normal;font-style:normal}`,
  );
  if (!/data:font\/woff2/.test(faCss)) {
    throw new Error('Failed to inline the Font Awesome webfont -- admonition icons would be blank.');
  }

  console.log(`Chrome:  ${chrome}`);
  console.log(`Source:  ${manualPath}`);

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    defaultViewport: VIEWPORT,
    args: ['--allow-file-access-from-files', '--font-render-hinting=none'],
  });

  try {
    /* One complete render: fresh page, hermetic load, transform, measure, print.
       Runs twice when a contents section is wanted -- the first pass discovers
       where every heading landed, the second bakes those page numbers in. */
    const renderOnce = async (tocNumbers) => {
      const page = await browser.newPage();

      /* Hermetic render: serve nothing from the network. The three jQuery/tocify
         CDN scripts and the two remote stylesheets all die here; the stylesheets
         are re-injected below from the mirror. */
      const blocked = new Set();
      const mathjaxServed = new Set();
      const mathjaxMissing = new Set();
      await page.setRequestInterception(true);
      page.on('request', async (req) => {
        const url = req.url();
        // file:// is the mirror; data:/blob:/about: are things we injected ourselves
        // (notably the inlined Font Awesome webfont).
        if (/^(file|data|blob|about):/.test(url)) return req.continue();

        // MathJax loads its loader, jax, extensions and web fonts on demand; serve
        // the lot from node_modules rather than reaching for the CDN.
        if (url.startsWith(MATHJAX_CDN)) {
          const rel = url.slice(MATHJAX_CDN.length).split('?')[0];
          try {
            const body = await readFile(join(MATHJAX_DIR, rel));
            mathjaxServed.add(rel);
            return req.respond({
              status: 200,
              contentType: mimeFor(rel),
              // Web fonts are CORS-checked even for a file:// document.
              headers: { 'Access-Control-Allow-Origin': '*' },
              body,
            });
          } catch {
            mathjaxMissing.add(rel);
            return req.abort();
          }
        }

        blocked.add(new URL(url).host);
        req.abort();
      });

      await page.goto(pathToFileURL(manualPath).href, {
        waitUntil: 'load',
        timeout: 120000,
      });

      /* Cascade order: site CSS, then Font Awesome, then our print rules last. */
      await page.addStyleTag({ content: siteCss });
      await page.addStyleTag({ content: faCss });
      await page.emulateMediaType('print');
      await page.addStyleTag({ content: printCss });

      /* Density knobs. print.css is authored at 10pt / 0.7in; anything else is an
         override applied on top, so the two stay in sync by construction. */
      if (args.baseFont !== 10 || args.margin !== 0.7) {
        await page.addStyleTag({
          content:
            `@page { size: Letter; margin: ${args.margin}in; }\n` +
            `html, body { font-size: ${args.baseFont}pt; }\n`,
        });
      }

      /* The one colour that departs from the source, exposed so it can be A/B'd.
         Pass --shift-blue #97B6E6 to render with the original web colour. */
      if (args.shiftBlue) {
        await page.addStyleTag({ content: `.bl { color: ${args.shiftBlue}; }` });
      }

      /* MathJax typesets at load time, before print.css lands, so its output would
         be sized for the 18px screen body. Force a rerender now that the final
         styles are applied, and wait for the queue to drain before measuring. */
      const math = await page.evaluate(async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (!(window.MathJax && window.MathJax.Hub && window.MathJax.Hub.Queue)) {
          if (Date.now() > deadline) return { ok: false, typeset: 0 };
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((resolve) => {
          window.MathJax.Hub.Queue(['Rerender', window.MathJax.Hub]);
          window.MathJax.Hub.Queue(resolve);
        });
        await document.fonts.ready;
        const faces = [...document.fonts]
          .filter((f) => /MathJax|MJX/i.test(f.family))
          .map((f) => `${f.family} ${f.style} ${f.status}`);
        return {
          ok: true,
          typeset: document.querySelectorAll('.MathJax_CHTML, .MathJax, .MathJax_SVG').length,
          faces,
          usesMathJaxFont: document.fonts.check('16px MathJax_Math'),
        };
      }, 180000);

      // Images must be decoded before naturalWidth is meaningful.
      await page.evaluate(async () => {
        await Promise.all(
          [...document.images].map((img) =>
            img.complete ? Promise.resolve() : img.decode().catch(() => {}),
          ),
        );
        await document.fonts.ready;
      });

      const report = await page.evaluate((opts) => {
        const { from, to, imageWidth, dpiFloor } = opts;
        const content = document.querySelector('#content');
        const stats = { figures: 0, leadIns: 0, images: [], stems: 0, dropped: 0, mathTypeset: 0 };

        /* ---- strip page furniture -------------------------------------- */
        document.querySelectorAll('script').forEach((s) => s.remove());
        document.querySelector('#toc')?.remove();
        document.querySelector('#preamble')?.remove();

        /* ---- harvest the front-matter before deleting it ---------------- */
        const titleEl = document.querySelector('h1.sect0, #content > h1');
        const introEl = document.querySelector('.openblock.partintro');
        const docTitle = (titleEl?.textContent ?? 'DM32 User Manual').trim();
        const introText = (introEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
        titleEl?.remove();
        introEl?.remove();

        /* "SwissMicros GmbH Copyright (c) 2016 - 2026 - v3.63 - 2026-07-05 - FW v2.10" */
        const brand = /^([^C]*?)\s*Copyright/.exec(introText)?.[1]?.trim() || 'SwissMicros GmbH';
        const version = introText.replace(/^.*?(Copyright)/, '$1').trim();

        /* ---- select the chapter range -----------------------------------
           Either bound may be null, meaning "no limit that side": --from 5 alone
           runs to the end, --to 5 alone starts at the beginning, and neither is
           the whole manual. */
        const chapters = [...content.querySelectorAll(':scope > .sect1')];
        const lo = from ?? 1;
        const hi = to ?? chapters.length;
        const kept = [];
        chapters.forEach((sect, i) => {
          const n = i + 1;
          if (n >= lo && n <= hi) {
            kept.push({ number: n, title: sect.querySelector('h2')?.textContent.trim() ?? '' });
          } else {
            sect.remove();
            stats.dropped++;
          }
        });
        const complete = kept.length === chapters.length;

        /* ---- generated title page --------------------------------------- */
        const scopeLine = complete
          ? `Complete manual — ${kept.length} chapters`
          : `Partial render — chapters ${kept[0]?.number}–${kept[kept.length - 1]?.number} of ${chapters.length}`;
        /* Listing chapter titles is useful when a handful were selected; at full
           length it is 26 lines and overruns the cover. The bookmark tree carries
           navigation for the complete document. */
        const scopeList = kept.length <= 8 ? kept.map((c) => c.title).join('<br>') : '';
        const cover = document.createElement('div');
        cover.className = 'dm32-title-page';
        cover.innerHTML = `
          <div class="brand">${brand}</div>
          <h1>${docTitle}</h1>
          <div class="rule"></div>
          <div class="version">${version}</div>
          <div class="scope">${scopeLine}</div>
          <div class="scope-list">${scopeList}</div>
          <div class="provenance">
            Rendered from ${opts.sourceUrl}<br>
            Retrieved ${opts.retrieved} · Typeset for US Letter
          </div>`;
        content.prepend(cover);

        /* ---- table of contents ------------------------------------------
           Built from the headings that exist right now, before the contents
           section adds a heading of its own, so it cannot list itself. Page
           numbers arrive on the second pass; until then each row carries a
           non-breaking space in a fixed-width column, so the two passes lay out
           identically and the numbers cannot shift the thing they describe. */
        let tocEntries = 0;
        if (opts.toc) {
          const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
          const wanted = ['H2', 'H3', 'H4'].slice(0, opts.tocDepth);
          const rows = [...content.querySelectorAll('h2, h3, h4')]
            .filter((h) => wanted.includes(h.tagName) && h.id)
            .map((h) => {
              const level = Number(h.tagName[1]) - 1; // h2 -> 1
              const num = opts.tocNumbers ? opts.tocNumbers[h.id] : undefined;
              return `<li class="toc-l${level}"><a href="#${h.id}">` +
                `<span class="toc-title">${esc(h.textContent.trim())}</span>` +
                `<span class="toc-dots"></span>` +
                `<span class="toc-page">${num == null ? '&nbsp;' : num}</span></a></li>`;
            });
          tocEntries = rows.length;
          const nav = document.createElement('nav');
          nav.className = 'dm32-toc';
          nav.innerHTML =
            `<h2 class="toc-heading">Contents</h2><ul class="toc-list">${rows.join('')}</ul>`;
          cover.after(nav);
        }

        /* ---- tag image-only paragraphs as figures ------------------------ */
        /* The manual writes most screenshots as a paragraph whose sole content is
           an inline <span class="image">, not as an .imageblock. Both shapes must
           behave like a figure for pagination. */
        content.querySelectorAll('.paragraph').forEach((p) => {
          if (p.querySelector('img') && p.textContent.trim() === '') {
            p.classList.add('figure-para');
            stats.figures++;
          }
        });

        /* ---- weld lead-in sentences to what they introduce --------------- */
        const introduced = '.figure-para, .imageblock, table.tableblock, .admonitionblock, .stemblock, .listingblock, .literalblock';
        content.querySelectorAll(introduced).forEach((el) => {
          const prev = el.previousElementSibling;
          if (!prev || !prev.classList.contains('paragraph')) return;
          if (prev.classList.contains('figure-para')) return;
          const text = prev.textContent.trim();
          /* A trailing colon is the manual's own signal ("...as shown below:").
             Weld only that, plus genuinely short fragments. Welding every
             paragraph makes the atomic unit paragraph+figure, which strands far
             more space at page bottoms than it saves in readability. */
          if (text.endsWith(':') || text.length < 120) {
            prev.classList.add('lead-in');
            stats.leadIns++;
          }
        });

        /* ---- size figures: cap width, but never enlarge past dpiFloor ---- */
        content.querySelectorAll('img').forEach((img) => {
          const attr = img.getAttribute('width') ?? '';
          if (attr.endsWith('px')) return; // authored inline icon, leave alone
          const natural = img.naturalWidth;
          if (!natural) return;
          const inches = Math.min(imageWidth, natural / dpiFloor);
          img.removeAttribute('width');
          img.removeAttribute('height');
          img.style.width = `${inches.toFixed(3)}in`;
          img.style.height = 'auto';
          stats.images.push({
            src: img.getAttribute('src').split('/').pop(),
            natural,
            inches: Number(inches.toFixed(3)),
            dpi: Math.round(natural / inches),
          });
        });

        /* ---- AsciiMath fallback ----------------------------------------
           With MathJax available this is dead code: it consumes the delimiters
           itself and replaces each expression with typeset output. It runs only
           when MathJax failed to load, so a degraded render shows plain algebra
           rather than raw markup with delimiters hanging off it. */
        if (!opts.mathTypeset) {
          const DELIM = String.fromCharCode(92) + '$';
          const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.nodeValue;
            if (t.indexOf(DELIM) === -1) continue;
            const parts = t.split(DELIM);
            if (parts.length % 2 === 0) continue; // unbalanced -- leave it alone
            let out = '';
            for (let i = 0; i < parts.length; i++) {
              if (i % 2 === 1) {
                out += parts[i].split('""').join('');
                stats.stems++;
              } else {
                out += parts[i];
              }
            }
            n.nodeValue = out;
          }
        }

        /* MathJax typesets the whole file at load, before the chapter range is
           applied, so its own count covers chapters we have since dropped. Count
           what actually survives into this render instead. */
        stats.mathTypeset = content.querySelectorAll('.MathJax_CHTML, .MathJax_SVG').length;

        /* Chrome emits one outline entry per heading, in this same document
           order, so the two lists can be zipped positionally rather than matched
           on title text. */
        const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({
          id: h.id || '',
          tag: h.tagName,
          text: h.textContent.trim(),
          inToc: !!h.closest('.dm32-toc'),
          inCover: !!h.closest('.dm32-title-page'),
        }));

        return { stats, kept, complete, chapterCount: chapters.length, docTitle, version, tocEntries, headings };
      }, {
        from: args.from,
        to: args.to,
        imageWidth: args.imageWidth,
        dpiFloor: args.dpiFloor,
        mathTypeset: math.ok,
        toc: args.toc,
        tocDepth: args.tocDepth,
        tocNumbers,
        sourceUrl: MANUAL_URL,
        retrieved: stamp.retrieved ?? 'unknown date',
      });

      /* ---- measurement pass ------------------------------------------------
         Only mark a block unbreakable once we know it actually fits. Applying
         break-inside:avoid to something taller than a page ejects it to a fresh
         page and strands the remainder of the previous one. */
      if (!report.kept.length) {
        const err = new Error(
          `No chapters in range: --from ${args.from ?? 1} --to ${args.to ?? report.chapterCount} ` +
            `matched none of the manual's ${report.chapterCount} chapters.`,
        );
        err.usage = true;
        throw err;
      }

      const measured = await page.evaluate((liveHeightPx, ratio, weldRatio) => {
        const limit = liveHeightPx * ratio;
        const weldMax = liveHeightPx * weldRatio;
        const height = (el) => el.getBoundingClientRect().height;

        /* Atomic blocks: marked only once measured to fit. */
        const sel =
          '.figure-para, .imageblock, table.tableblock, .admonitionblock, .listingblock, .literalblock';
        let kept = 0;
        const tooTall = [];
        document.querySelectorAll(sel).forEach((el) => {
          const h = height(el);
          if (h <= limit) {
            el.classList.add('keep-whole');
            kept++;
          } else {
            tooTall.push({ kind: el.className.split(' ')[0], heightIn: Number((h / 96).toFixed(2)) });
          }
        });

        /* List items follow the same rule: short ones atomic, tall ones breakable. */
        let items = 0;
        document.querySelectorAll('li').forEach((el) => {
          if (height(el) <= limit) {
            el.classList.add('keep-whole');
            items++;
          }
        });

        /* Widow/orphan welding, but only where the pair being dragged is small. */
        let welds = 0;
        document.querySelectorAll('ul, ol, tbody').forEach((list) => {
          const kids = [...list.children].filter((c) => c.tagName === 'LI' || c.tagName === 'TR');
          if (kids.length < 2) return;
          const n = kids.length;

          /* With two or three items the head weld and the tail weld overlap, so
             applying both leaves no legal break anywhere and the whole list turns
             atomic. Test affordability against the entire list in that case --
             testing pairs would wave through a 3-item list whose pairs each fit
             but whose total does not. */
          if (n <= 3) {
            const total = kids.reduce((a, k) => a + height(k), 0);
            if (total <= weldMax) {
              kids[0].classList.add('weld-next');
              welds++;
              if (n === 3) {
                kids[1].classList.add('weld-next');
                welds++;
              }
            }
            return;
          }

          /* Four or more: the two welded pairs are disjoint, so a break survives
             between them and each pair can be judged on its own. */
          if (height(kids[0]) + height(kids[1]) <= weldMax) {
            kids[0].classList.add('weld-next');
            welds++;
          }
          if (height(kids[n - 2]) + height(kids[n - 1]) <= weldMax) {
            kids[n - 2].classList.add('weld-next');
            welds++;
          }
        });

        const contentPx = document.querySelector('#content').getBoundingClientRect().height;
        const figurePx = [...document.querySelectorAll('.figure-para img, .imageblock img')]
          .reduce((a, i) => a + height(i), 0);

        return {
          kept,
          items,
          welds,
          tooTall,
          limitIn: Number((limit / 96).toFixed(2)),
          weldMaxIn: Number((weldMax / 96).toFixed(2)),
          idealPages: contentPx / liveHeightPx,
          figureIn: figurePx / 96,
        };
      }, VIEWPORT.height, args.keepWholeRatio, args.weldRatio);

      /* Only images still in the document matter -- Chrome fetched every image in
         the file during load, including the chapters we then dropped. */
      const failedImages = await page.evaluate(() =>
        [...document.images]
          .filter((i) => !i.complete || i.naturalWidth === 0)
          .map((i) => i.getAttribute('src')),
      );

      /* Cross-references into chapters this render dropped cannot resolve. Expected
         for a partial render; should be 12 for the complete manual. */
      const links = await page.evaluate(() => {
        const internal = [...document.querySelectorAll('#content a[href^="#"]')];
        const dangling = internal.filter((a) => !document.getElementById(a.hash.slice(1)));
        return { internal: internal.length, dangling: dangling.length };
      });

      if (args.dumpHtml) {
        const html = await page.content();
        await mkdir(OUT, { recursive: true });
        await writeFile(join(OUT, 'transformed.html'), html, 'utf8');
      }

      /* ---- print ------------------------------------------------------- */
      const pdf = await page.pdf({
        printBackground: true, // key chips are white-on-dark backgrounds
        preferCSSPageSize: true, // honour @page { size: Letter }
        margin: {
          top: `${args.margin}in`,
          right: `${args.margin}in`,
          bottom: `${args.margin}in`,
          left: `${args.margin}in`,
        },
        displayHeaderFooter: false,
        tagged: true,
        outline: true, // heading tree -> PDF bookmarks
        timeout: 600000, // a full 26-chapter print is far heavier than a pilot
      });

      await page.close();
      return {
        pdf, report, measured, math, links, failedImages,
        blocked, mathjaxServed, mathjaxMissing,
      };
    };

    let result = await renderOnce(null);

    /* Named after what it actually contains, which is only known once the range
       has been resolved against the real chapter count: the complete manual is
       plain dm32_user_manual.pdf, a slice carries its range in the name. */
    const kept = result.report.kept;
    const outPath =
      args.out ??
      join(
        OUT,
        result.report.complete
          ? 'dm32_user_manual.pdf'
          : `dm32_user_manual_ch${kept[0].number}-${kept[kept.length - 1].number}.pdf`,
      );
    await mkdir(dirname(outPath), { recursive: true });

    let toc = { entries: 0, frontMatterPages: 0, wrong: 0 };

    if (args.toc) {
      /* Pass 1 exists only to find out where things landed. Chrome's bookmark
         tree has one entry per heading in document order, and the DOM pass
         returned the headings in that same order, so they zip positionally. */
      const outline1 = readOutline(await load(Buffer.from(result.pdf)));
      const headings1 = result.report.headings;
      if (outline1.length !== headings1.length) {
        throw new Error(
          `Cannot map headings to pages: ${outline1.length} outline entries vs ` +
            `${headings1.length} headings. The two must correspond one to one.`,
        );
      }

      /* Front matter is the cover plus whatever the contents took; body page
         numbering restarts at 1 after it, which is what the contents must cite. */
      const bodyStart = headings1.findIndex((h) => !h.inCover && !h.inToc);
      const front1 = outline1[bodyStart].page - 1;
      const numbers = {};
      headings1.forEach((h, i) => {
        if (h.inCover || h.inToc || !h.id) return;
        numbers[h.id] = outline1[i].page - front1;
      });

      result = await renderOnce(numbers);

      /* Trust but verify: re-read the second pass and confirm every number we
         printed is the page that heading actually ended up on. Filling fixed
         width placeholders should not move anything, and this proves it. */
      const outline2 = readOutline(await load(Buffer.from(result.pdf)));
      const headings2 = result.report.headings;
      const front2 = outline2[headings2.findIndex((h) => !h.inCover && !h.inToc)].page - 1;
      let wrong = 0;
      headings2.forEach((h, i) => {
        if (h.inCover || h.inToc || !h.id) return;
        if (numbers[h.id] !== outline2[i].page - front2) wrong++;
      });
      toc = { entries: result.report.tocEntries, frontMatterPages: front2, wrong };
    }

    let finalBytes = Buffer.from(result.pdf);
    let stamped = 0;
    if (args.pageNumbers) {
      const doc = await load(finalBytes);
      stamped = await stampPageNumbers(doc, {
        coverPages: 1,
        frontMatterPages: toc.frontMatterPages,
        marginIn: args.margin,
      });
      finalBytes = Buffer.from(await doc.save());
    }
    await writeFile(outPath, finalBytes);

    const {
      report, measured, math, links, failedImages, blocked, mathjaxServed, mathjaxMissing,
    } = result;

    /* ---- report ------------------------------------------------------ */
    const pages = pageCount(await load(finalBytes));
    const imgs = report.stats.images;
    const minDpi = imgs.length ? Math.min(...imgs.map((i) => i.dpi)) : null;

    console.log(`\nChapters: ${report.kept.map((c) => c.number).join(', ')} of ${report.chapterCount}`);
    for (const c of report.kept) console.log(`   ${c.title}`);
    console.log(`\nTransform:`);
    console.log(`   figure paragraphs tagged   ${report.stats.figures}`);
    console.log(`   lead-in sentences welded   ${report.stats.leadIns}`);
    console.log(`   images resized             ${imgs.length} (cap ${args.imageWidth}in, min ${minDpi} dpi)`);
    console.log(`   maths typeset by MathJax   ${report.stats.mathTypeset}${math.ok ? '' : '  (MathJax FAILED to load)'}`);
    console.log(`   delimiter fallback used    ${report.stats.stems}`);
    console.log(`   MathJax files served       ${mathjaxServed.size} from node_modules`);
    console.log(`   chapters dropped           ${report.stats.dropped}`);
    console.log(`\nPagination:`);
    console.log(`   blocks kept whole          ${measured.kept} (fit under ${measured.limitIn}in)`);
    console.log(`   list items kept whole      ${measured.items}`);
    console.log(`   widow welds applied        ${measured.welds} (pairs under ${measured.weldMaxIn}in)`);
    console.log(`   left breakable (too tall)  ${measured.tooTall.length}`);
    for (const t of measured.tooTall) console.log(`      ${t.kind} ${t.heightIn}in`);
    console.log(`   figure height total        ${measured.figureIn.toFixed(1)}in`);
    console.log(`   content needs              ${measured.idealPages.toFixed(1)} pages of live area`);
    console.log(`\nCross-references:`);
    console.log(`   internal links             ${links.internal}`);
    console.log(`   pointing outside range     ${links.dangling}${report.complete ? '' : ' (expected for a partial render)'}`);
    console.log(`\nFront matter:`);
    console.log(`   contents entries           ${args.toc ? `${toc.entries} (depth ${args.tocDepth})` : 'disabled'}`);
    console.log(`   pages before body page 1   ${toc.frontMatterPages + 1} (cover + contents)`);
    console.log(`   page numbers verified      ${verdict(args.toc, toc.wrong)}`);
    console.log(`   numbers stamped            ${args.pageNumbers ? stamped : 'disabled'}`);

    /* ---- diagnostics --------------------------------------------------- */
    if (blocked.size) console.log(`\nNetwork blocked: ${[...blocked].join(', ')}`);

    if (process.env.DM32_DEBUG) {
      console.log('\nMathJax files served:');
      for (const f of [...mathjaxServed].sort()) console.log(`   ${f}`);
      console.log('MathJax font faces:');
      for (const f of math.faces ?? []) console.log(`   ${f}`);
      console.log(`   document.fonts.check('16px MathJax_Math'): ${math.usesMathJaxFont}`);
    }

    if (mathjaxMissing.size) {
      console.error(`\n${mathjaxMissing.size} MathJax file(s) missing from node_modules:`);
      for (const f of [...mathjaxMissing].slice(0, 10)) console.error(`   ${f}`);
      console.error('   Run: npm install');
      process.exitCode = 1;
    }
    if (failedImages.length) {
      console.error(`\n${failedImages.length} image(s) in range missing from cache:`);
      for (const u of failedImages.slice(0, 10)) console.error(`   ${u.split('/').pop()}`);
      console.error('   Run: node fetch-assets.mjs --from N --to M');
      process.exitCode = 1;
    }
    if (toc.wrong) process.exitCode = 1;

    console.log(`\nWrote ${outPath}`);
    console.log(`   ${pages} pages, ${(finalBytes.length / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // Usage errors are the user mistyping a flag; a stack trace only buries the message.
  console.error(err.usage ? err.message : err);
  process.exit(1);
});
