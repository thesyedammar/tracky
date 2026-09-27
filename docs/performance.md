# Tracky — measured performance

Every number here was measured on this machine, not estimated. Re-run the pieces
yourself with the commands at the bottom.

## Where the time goes

A search has exactly three phases, and only one of them is slow:

| Phase | What happens | Measured |
| --- | --- | --- |
| 1. Collect | walk the page, build blocks with exact offsets | **2–31 ms** |
| 2. Model | one request per 80-passage batch, run in sequence | **~600–1200 ms per batch** |
| 3. Render + highlight | paint results, highlight the sentence in place | **< 16 ms** (one frame) |

The model call dominates, so the engineering that matters is *not sending more text
than needed* — which is what scope chips and the block caps are for.

## Collector: 10 real pages, live in Chrome

| Page | Passages | Characters | Collector time |
| --- | --- | --- | --- |
| en.wikipedia.org/wiki/Insurance | 345 | 99,021 | 31 ms |
| en.wikipedia.org/wiki/Eviction | 128 | 28,385 | 27 ms |
| gnu.org/licenses/gpl-3.0.en.html | 109 | 34,699 | 16 ms |
| en.wikipedia.org/wiki/Lease | 107 | 34,923 | 13 ms |
| wikisource.org — US Constitution | 98 | 28,423 | 7 ms |
| wikisource.org — UDHR | 67 | 11,338 | 7 ms |
| en.wikipedia.org/wiki/Security_deposit | 33 | 6,798 | 6 ms |
| en.wikipedia.org/wiki/Rental_agreement | 49 | 14,729 | 5 ms |
| MDN — CSS Custom Highlight API | 28 | 3,528 | 2 ms |
| nodejs.org/en/about | 16 | 3,319 | 2 ms |

Worst case is **31 ms for 345 passages** — about 2% of a typical search's wall-clock
time. The collector is never the reason a search feels slow.

## End-to-end searches (real pages, real model)

| Target | Passages sent | Batches | Result | Wall-clock |
| --- | --- | --- | --- | --- |
| Local fixture | 10 | 1 | 6 matches | 723–736 ms |
| en.wikipedia.org/wiki/Lease | 106–107 | 2 | 5 matches | 1.05–1.5 s |
| Same query again (cache hit) | — | 0 | same results | instant, no model call |
| Scoped to one section | 6 (of 107) | 1 | scoped matches | ~750 ms |

## PDF mode (15-page paper, first open)

| Step | Measured |
| --- | --- |
| Render all 15 pages + text layers | 4.0 s (measured, cold open) |
| Collect from the text layers | 38 blocks / 40,434 chars |
| Highlight a sentence | immediate (Custom Highlight API) |

PDF rendering is proportional to page count and happens **once** — searches after
that are the same speed as on an HTML page.

## What makes it fast

1. **One request per 80 passages, not one per passage.** A 345-passage page costs
   5 model calls, not 345.
2. **`TreeWalker` with `FILTER_REJECT`** prunes nested duplicates before they are
   visited — no O(N²) descendant scans on large pages.
3. **Cheap test first, expensive query second.** `hasDirectLongText` runs on every
   container; the `querySelector` fallback only runs for real candidates.
4. **One FNV-1a pass** over block text gives the cache fingerprint, so "same page?"
   costs nothing extra.
5. **The CSS Custom Highlight API paints ranges** instead of wrapping text in
   `<mark>` — no DOM mutation, no reflow storm, no React reconciliation.
6. **700 ms debounce + generation counters** mean typing never queues stale work.
7. **A short cache** (10 minutes, 24 entries, keyed by URL + page fingerprint)
   makes re-asking free.
8. **Scope chips shrink the search space** — 107 passages become 6 when you scope to
   a section, which cuts both time and cost.

## Honest limits

- The free model route rate-limits under heavy use; Tracky reports the real wait
  instead of pretending to search (see `server/search.mjs`).
- A 1,000-passage page is ~13 batches, so it takes ~8–13 s. Scope chips are the fix.
- PDF mode builds the text layer for every page up front (that is what makes search
  instant afterwards) but paints canvases lazily: a 15-page paper opens in **~1.8 s**,
  and only the pages near the reader hold a pixel buffer — measured at the end of a
  15-page document, **2 of 16 canvases allocated (~8 MB)** with the first page's buffer
  returned, and a page scrolled back to repaints (`pdf-smoke.py` asserts both).
- The collector caps at 600 passages / 400k characters, so search stays bounded even
  on a 300-page PDF.
- Column-aware PDF ordering is heuristic: it is used only when every detected column
  holds a real share of a band's lines, and otherwise the reader falls back to the
  PDF's own line order (verified against a real two-column paper: 0 blocks stitch two
  columns together).

## Re-run it

```bash
python3 scripts/realpage-suite.py --collect     # collector timings on 10 real pages
node scripts/benchmark.mjs                      # fixed suite through the real model
xvfb-run -a python3 scripts/pdf-smoke.py        # PDF rendering + extraction
node scripts/key-leak-check.mjs                 # the privacy claim
```
