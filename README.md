# DM32 User Manual → PDF

The [SwissMicros DM32](https://www.swissmicros.com/product/dm32) ships its user manual as a
single 1 MB HTML page and nothing else. There is no PDF, so there is no good way to read it
on a tablet, annotate it, or keep a copy on the shelf next to the calculator.

This is a small pipeline that turns that page into a properly typeset **200-page US Letter
PDF** — bookmarked, page-numbered, with a real table of contents, and with page breaks that
fall where a typesetter would put them rather than wherever the text happened to run out.

![Title page, contents, and a body page from the rendered PDF](docs/sample-pages.png)

## What you get

- **Structural pagination** — chapters start a fresh page, headings never dangle at the foot
  of one, and figures stay with the sentence that introduces them.
- **A generated title page and table of contents** with real page numbers, verified against
  the finished file on every build.
- **Book-convention numbering** — no number on the cover, roman numerals on the contents,
  arabic restarting at 1 for the body.
- **329 PDF bookmarks** from the manual's own heading tree, plus working internal
  cross-references.
- **Sharp screenshots** — images are sized in inches and never upscaled past 220 dpi; the
  worst figure in the full render still lands at 259 dpi.
- **Typeset equations.** The manual's 544 AsciiMath expressions go through MathJax, so they
  look the way they do on the website rather than degrading to raw markup.
- **Faithful colour** — the manual's brown headings and orange/blue shift labels are kept.

## Requirements

- **Node.js 18+**
- **Google Chrome, Chromium, or Microsoft Edge** already installed

There is no bundled browser to download: the pipeline uses `puppeteer-core` and drives the
one you already have. Common install locations on Windows, macOS and Linux are probed
automatically — set `PUPPETEER_EXECUTABLE_PATH` if yours lives somewhere unusual.

## Quick start

Render the whole manual:

```bash
npm install && node fetch-assets.mjs --all && node render.mjs --all
```

That writes `out/dm32_user_manual_full.pdf`. The fetch pulls 222 images (about 3 MB) and
takes a couple of minutes on first run; everything is cached afterwards. The render itself
takes roughly a minute — two full passes plus a verification pass.

Prefer to try it on a slice first? The default range is chapters 1–3:

```bash
npm install && node fetch-assets.mjs && node render.mjs
```

That gives you a 19-page `out/dm32_user_manual_ch1-3.pdf` in a few seconds.

## A note on copyright

**The manual is copyright SwissMicros GmbH. This repository does not contain any of it.**

`fetch-assets.mjs` downloads the manual to a local `cache/` directory at runtime, and the
rendered PDF lands in `out/`. Both are gitignored, deliberately. This is a tool for making
yourself a readable copy of a document that is already published for free — please don't
use it to redistribute SwissMicros' work.

The fetcher identifies itself with a descriptive User-Agent, requests three files at a time
rather than flooding the origin, and honours `Retry-After` when the server pushes back.

## Options

```
node fetch-assets.mjs [--from N] [--to M] [--all] [--refresh]

node render.mjs       [--from N] [--to M] [--all]
                      [--out PATH]
                      [--image-width IN]      figure width cap        (default 3.6)
                      [--dpi-floor DPI]       never upscale past this (default 220)
                      [--base-font PT]        body size               (default 10)
                      [--margin IN]           page margin             (default 0.7)
                      [--shift-blue HEX]      .bl label colour        (default #4A82D6)
                      [--keep-whole-ratio R]  atomic-block threshold  (default 0.45)
                      [--weld-ratio R]        widow-weld threshold    (default 0.25)
                      [--no-toc]              skip the contents section
                      [--toc-depth N]         1=chapters 2=+sections 3=+sub (default 2)
                      [--no-page-numbers]     leave the margins clean
                      [--dump-html]           write out/transformed.html for inspection

node preview.mjs PDF [first] [last] [scale] [step]    rasterise pages to out/preview/
```

`print.css` is authored at 10 pt / 0.7 in. `--base-font` and `--margin` are applied as an
override on top of it rather than replacing it, so the stylesheet and the flags cannot drift
apart.

Contents depth defaults to 2 — chapters plus sections, 149 entries over 3 pages. `--toc-depth 3`
adds all 178 subsections, which runs to about 7 pages of contents.

---

# How it works

Six small files do the work.

| File | Role |
|---|---|
| `fetch-assets.mjs` | Mirrors the manual, both stylesheets, the Font Awesome webfont and every referenced image into `cache/`, laid out by host + path. The HTML is stored byte-identical to upstream. |
| `print.css` | The print stylesheet: page geometry, density, and the page-break policy. |
| `render.mjs` | Drives Chrome: restructures the DOM, measures it, and prints. |
| `pdf-tools.mjs` | Reads page positions back out of a rendered PDF, and stamps page numbers onto it. |
| `chrome.mjs` | Finds an installed Chromium-based browser. |
| `preview.mjs` | Rasterises pages of a finished PDF to PNG so pagination can be eyeballed. |

## Hermetic rendering

The page is loaded from `cache/` over `file://` and **every off-disk request is aborted** —
the jQuery and tocify CDN scripts, the remote stylesheets, the lot. The site's stylesheets
are re-injected from the mirror instead, which also guarantees `print.css` lands last in
cascade order without having to fight specificity.

The upshot is that a render depends on nothing but the contents of `cache/` and your Chrome
version. Two people running it a year apart get the same document.

## The DOM pass

Restructuring happens in the live DOM inside `page.evaluate`, not through an HTML parser.
That avoids a parsing dependency, and — much more importantly — it means the pipeline can
**measure real rendered geometry** before deciding how to paginate. It:

- Removes the scripts, the fixed left-hand TOC sidebar, and the preamble.
- Harvests the title and version line, then builds a title page from them.
- Drops chapters outside the requested range.
- Tags **figure paragraphs**. Most screenshots in this manual are not `.imageblock`s at all;
  they are a `<div class="paragraph">` whose only content is an inline `<span class="image">`.
  Both shapes have to behave like a figure.
- Welds **lead-in sentences** to what they introduce — the manual constantly writes
  "…as shown below:" immediately before a screenshot.
- Sizes every figure to an explicit width in inches, capped so no image is ever enlarged past
  `--dpi-floor`. Images carrying an authored pixel width (inline key and status icons) are
  left alone.

## Measured pagination

This is the part that matters, and the part most HTML-to-PDF setups get wrong.

Blocks are marked unbreakable (`break-inside: avoid`) **only once measured to fit** — under
45% of live page height by default. Applying `avoid` blindly to something taller than a page
does not keep it together; it ejects it to a fresh page and strands the remainder of the
previous one. That is the usual reason naive output is full of holes. In the full manual, 22
elements (mostly long reference tables, one of them 65 inches tall) are correctly left
breakable for exactly this reason.

To make the measurement meaningful, the viewport is set to the print content box —
7.1 × 9.6 in at 96 dpi for the default margins — so the browser lays the document out at the
same width Chrome will use when it paginates.

### Page-break policy

| Rule | Rationale |
|---|---|
| `.sect1` starts a new page | A numbered chapter is the document's top-level unit |
| No heading ends a page | Otherwise its content is orphaned overleaf. The site's own CSS covers h2/h3 only; h4 appears 178× |
| Lead-in sentence stays with its figure | "…as shown below:" must not be the last line on a page |
| Figures never split | An image is not worth breaking at any size |
| Table rows never split; headers repeat | `thead { display: table-header-group }` |
| Short list items never split | Tall ones stay breakable, same measured rule as blocks |
| No lone first/last list item or table row | Welded only where cheap — see below |
| `orphans: 3; widows: 3` | Standard typographic minimum |

### Widow welding, and why it has to be measured

CSS `orphans`/`widows` only govern line boxes **inside one block**, so they do nothing when
a `<ul>` breaks between its `<li>` children — which is exactly how a single bullet ends up
stranded at the top of a page. The cure is to forbid the break after the first item and
before the last one, written as `break-after: avoid` on the *preceding* sibling (Chrome
honours that far more reliably than `break-before: avoid`), so a stray item drags a
neighbour along with it.

This cannot be a blanket rule. A flat `li:first-child, li:nth-last-child(2)` selector
silently makes every list of three or fewer items atomic — harmless for a three-line bullet
list, ruinous for a three-step procedure with a screenshot in each step. One such list, 8.4 in
tall, ejected itself onto a fresh page and stranded 5.5 in behind it. So `render.mjs` measures
first and welds only when what it would drag along is under `--weld-ratio` (25%) of page
height. Table rows go through the same path.

One subtlety worth keeping: in a list of two or three items the head weld and the tail weld
*overlap*, so applying both leaves no legal break and the list turns atomic anyway. Those
cases are therefore tested against the whole list, not against a pair — otherwise a
three-item list whose pairs each fit but whose total does not sails straight through.

## Contents and page numbers

Where a heading lands is only knowable after Chrome has paginated, so the table of contents
takes **two passes**. The trick is that no extra measuring machinery is needed: Chrome already
emits a bookmark entry per heading, and each entry's destination names its page directly — so
the outline doubles as the heading-to-page map.

1. Render with the contents in place but every page number a non-breaking space.
2. Read the outline, zip it positionally against the headings the DOM pass reported (both are
   in document order, so no title-text matching is involved), and compute each body page number.
3. Render again with the numbers filled in.
4. **Verify** — re-read the second pass and confirm every printed number is the page that
   heading actually ended up on. Reported on every run; a mismatch fails the build.

Step 4 matters because step 3 could in principle repaginate the contents and invalidate its own
numbers. It cannot here, because the number column is fixed-width (`min-width: 2.4em`,
`tabular-nums`), so substituting real numbers for placeholders changes only the length of the
dot leaders — but that is an argument, and the check is proof.

Page numbers are stamped by `pdf-tools.mjs` rather than by Chrome's `displayHeaderFooter`,
because that template is identical on every sheet and cannot vary by page — it can neither skip
the cover nor switch numbering scheme partway through. The round-trip through `pdf-lib`
preserves the outline, link annotations, named destinations and the tagged structure tree. It
also re-packs objects into compressed streams, which makes the file smaller and means raw
text-searching a finished PDF no longer finds `/Type /Page` — use `pdf-tools.mjs` to inspect one.

## Maths

The manual marks its equations up as AsciiMath and typesets them with **MathJax 2.7.9**, loaded
from cdnjs and configured for backslash-dollar delimiters in an inline `x-mathjax-config` block.
544 expressions depend on it, concentrated in chapters 17–19.

Because the render is hermetic, requests to the MathJax CDN are served from the local `mathjax`
npm package instead — the whole tree: loader, jax, extensions and web fonts. That pins the
version to `package.json` rather than to whatever cdnjs is serving today.

MathJax typesets at load time, before `print.css` lands, so its output would otherwise be sized
for the 18 px screen body. `render.mjs` forces a rerender once the final styles are applied and
waits for the queue — and for `document.fonts.ready` — before measuring anything.

If MathJax ever fails to load the render does not fall over: a fallback pass strips the
delimiters so expressions read as plain algebra rather than raw markup. Every run reports which
path it took, so a silent regression to the fallback is visible:

```
   maths typeset by MathJax   544
   delimiter fallback used    0
   MathJax files served       17 from node_modules
```

`DM32_DEBUG=1` additionally lists the files served and every MathJax `@font-face` with its load
status. The `-R` and `-Rx` variants reporting `error` there is **normal** — MathJax declares each
face three times and tries a `local()` copy first; the `-Rw` (woff) variants are the ones that
must say `loaded`.

## Tuning density

Measured on chapters 1–3, all with cover and contents included:

| Configuration | Content height | Printed |
|---|---|---|
| 10 pt / 0.7 in / 3.6 in figures (default) | 16.3 pages | **19** |
| 10 pt / 0.7 in / 2.9 in figures | 15.5 pages | 19 |
| 9.5 pt / 0.65 in / 3.2 in figures | 15.4 pages | 19 |
| 9 pt / 0.6 in / 3.0 in figures | 14.5 pages | 17 |

Note what the first three rows do: nearly a page of content height disappears and the printed
count does not move. Figures are only about 28% of content height here, so shrinking them frees
space that gets reabsorbed as larger gaps at page bottoms rather than turning into fewer sheets.
Typography is the real lever, and 10 pt is already fairly tight for a reference manual — which
is why the default keeps the figures large.

## Verifying a render

Every run prints what it did — figures tagged, minimum effective image dpi, blocks kept whole,
widow welds applied, how many pages the content actually needs versus how many were printed
(the gap is space lost to break rules), and how many cross-references point outside the
rendered range.

To look at the result:

```bash
node preview.mjs out/dm32_user_manual_full.pdf 1 200 1.5 10
```

That rasterises every tenth page to `out/preview/` for a quick flip-through.

## Troubleshooting

**"No Chrome, Chromium or Edge found"** — set `PUPPETEER_EXECUTABLE_PATH` to your browser
binary. The error lists everywhere it looked.

**"Cache incomplete — run node fetch-assets.mjs first"** — the render needs the mirror. If you
widened the chapter range, re-run the fetch with the same range.

**Images missing from cache** — the render names them and exits non-zero. Re-run the fetch;
`--refresh` forces a re-download of files already present.

**429s during fetch** — the origin rate-limits bursts. The fetcher already backs off and
retries up to five times; if it still fails, wait a few minutes and run it again. Anything
already downloaded is skipped.

## Known limitations

- **12 cross-references do not resolve.** They are broken in the source document and dead on
  the website too — targets like `#Loops with counters (DSE` (a malformed AsciiDoc xref) and
  `#File`, `#Settings`, `#battery`, which no element defines. The render reports the count every
  time; it should read 12 for `--all`, and any increase means something in this pipeline dropped
  an anchor.
- The site's own `Theinhardt` webfonts return 404 upstream, so the page already falls back to a
  system sans. `print.css` names the stack explicitly to keep output reproducible.
- Blue shift labels (`.bl`) are the one colour that departs from the source. Bold 10 pt
  `#97B6E6` is washed out on white paper, so it moves to `#4A82D6` — same hue and saturation,
  raised to the *lightness of the orange it sits beside* (L56% against `#F99A2B`'s L57%) so the
  two label colours carry equal weight on the page. Pass `--shift-blue #97B6E6` for the original.
  The `.bls` swatches keep the original colour deliberately: they are pictures of the physical
  key and need to match the keypad photographs.

## Licence

The code here is MIT-licensed — see [LICENSE](LICENSE).

The DM32 user manual is copyright SwissMicros GmbH and is not part of this repository. This
tool is not affiliated with or endorsed by SwissMicros.
