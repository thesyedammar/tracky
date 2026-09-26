// Tracky — PDF mode (Phase 13).
//
// Renders a PDF inside an extension page with pdf.js, then exposes the *same*
// collector contract the content script uses on normal pages:
//
//   window.__trackyCollect() → { blocks, stats, byId, sections }
//
// Because the shape is identical, the panel in content.js needs no PDF-specific
// code: it sends blocks, gets sentences back, and highlights them through the
// PDF's own text layer — a hit glows on the page itself.
//
// Nothing here talks to the network except the PDF's own URL, and nothing is
// sent anywhere until the user searches.

import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const MIN_BLOCK_CHARS = 40;
const MAX_BLOCKS = 600;
const MAX_CHARS = 400_000;
// One block = one comfortable paragraph-ish chunk. A PDF line is a text item, not a
// paragraph, so blocks are assembled from consecutive spans until the layout says
// "new paragraph" (a vertical gap or a column change) or the chunk gets long.
const CHUNK_MAX_CHARS = 1400;

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const src = params.get("src") ?? "";
const name = params.get("name") || src.split("/").pop() || "document.pdf";

const ui = {
  name: el("name"),
  meta: el("meta"),
  load: el("load"),
  title: el("load-title"),
  msg: el("load-msg"),
  bar: el("load-bar"),
};

function fail(title, message) {
  ui.title.textContent = title;
  ui.msg.textContent = message; // textContent, never innerHTML — error text is data
  ui.bar.parentElement.style.display = "none";
}

ui.name.textContent = name;
ui.name.title = src;

/** Build the page element for one page: a placeholder + its text layer.
 *
 *  The text layer is what Tracky searches, so it is built for every page up front
 *  (cheap: strings and spans). The canvas — the expensive part, ~16 MB each at 2×
 *  device pixels — is rendered lazily as the reader approaches the page, so a long
 *  PDF opens fast and does not sit on hundreds of megabytes of pixels. */
async function buildPage(doc, n, targetWidth) {
  const page = await doc.getPage(n);
  // Each page computes its own scale from the target width, so a document with mixed
  // page sizes (or rotation) still fits the window correctly.
  const scale = targetWidth / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });

  const wrap = document.createElement("div");
  wrap.className = "page";
  wrap.dataset.page = String(n);
  wrap.style.width = `${Math.floor(viewport.width)}px`;
  wrap.style.height = `${Math.floor(viewport.height)}px`;

  const canvas = document.createElement("canvas");
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.dataset.pending = "1";
  wrap.appendChild(canvas);

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  textLayerDiv.style.setProperty("--scale-factor", viewport.scale);
  wrap.appendChild(textLayerDiv);
  el("pages").appendChild(wrap);

  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();

  const paint = async () => {
    if (canvas.dataset.pending !== "1" || canvas.dataset.rendering === "1") return;
    canvas.dataset.rendering = "1"; // a free() during the render must not zero this canvas
    try {
      // Restore the pixel buffer that free() released — a repaint after a free must
      // come back at full size, not into a 0×0 canvas.
      const w = Math.floor(viewport.width * ratio);
      const h = Math.floor(viewport.height * ratio);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      await page.render({
        canvasContext: canvas.getContext("2d", { alpha: false }),
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      }).promise;
      delete canvas.dataset.pending; // cleared only on success
    } catch (err) {
      canvas.dataset.pending = "1"; // stay armed: the next visit tries again
      throw err;
    } finally {
      delete canvas.dataset.rendering;
    }
  };
  const free = () => {
    // Never free a canvas that is mid-render: the render would be written into a
    // 0×0 buffer and the page would stay blank.
    if (canvas.dataset.pending === "1" || canvas.dataset.rendering === "1") return false;
    canvas.dataset.pending = "1";
    canvas.width = 0; // release the pixel buffer, keep the layout box
    canvas.height = 0;
    return true;
  };
  return { wrap, paint, free };
}

/** Render canvases as the reader approaches them, and release the ones left far
 *  behind — so a 300-page document never sits on hundreds of megabytes of pixels.
 *  Released pages repaint when the reader comes back (the observer is re-armed). */
function lazyPaint(pages) {
  const paintSafely = (entry, wrap) => {
    entry.paint().catch((err) => {
      wrap.dataset.paintError = String(err?.message ?? err); // visible to tests, never silent
      io.observe(wrap); // re-arm: the next visit to this page tries again
    });
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const wrap = e.target;
        const entry = pages.get(Number(wrap.dataset.page));
        if (entry) paintSafely(entry, wrap);
        io.unobserve(wrap);
      }
    },
    { rootMargin: "150% 0px" },
  );
  for (const [n, entry] of pages) {
    if (n <= 2) paintSafely(entry, entry.wrap);
    else io.observe(entry.wrap);
  }

  // Memory bound: canvases well outside the viewport are freed and re-armed.
  const KEEP_SCREENS = 3;
  let queued = false;
  const prune = () => {
    queued = false;
    for (const [, entry] of pages) {
      const r = entry.wrap.getBoundingClientRect();
      const far = r.bottom < -window.innerHeight * KEEP_SCREENS || r.top > window.innerHeight * (KEEP_SCREENS + 1);
      if (far && entry.free()) io.observe(entry.wrap);
    }
  };
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(prune);
    },
    { passive: true },
  );
  return io;
}

/** Assemble a page's spans into lines, then lines into paragraph-ish blocks.
 *
 *  Reading order matters and PDF text items are not always in it, so spans are first
 *  grouped into visual lines (by vertical position), each line sorted left→right, and
 *  the lines ordered by (column, top). A line whose start jumps right by a lot while
 *  the text continues on the same vertical band starts a new column — that is what
 *  keeps a two-column paper's columns from being interleaved into one block.
 *
 *  The block text is built from the spans themselves, so every character we send is a
 *  character that exists in the text layer, and every returned sentence maps back to
 *  the exact span range that painted it (the same never-fabricate guarantee the HTML
 *  path has). A word split across lines is re-joined and the hyphen dropped, so
 *  "trans-\nformer" reads as "transformer" — the mapping is adjusted with it. */
function blocksFromPage(wrap, n, registry, seen, sections, skipped) {
  const div = wrap.querySelector(".textLayer");
  if (!div) return [];
  const spans = [...div.querySelectorAll("span")].filter(
    (s) => s.firstChild && s.firstChild.nodeType === Node.TEXT_NODE && s.firstChild.data.length > 0,
  );
  if (!spans.length) return [];

  // Geometry. style.left/top is the text layer's own coordinate system and is what
  // pdf.js always sets, so it is read first; the rect is consulted only when a style
  // is missing (one forced layout instead of one per span on thousand-span pages).
  // Run widths are estimated from the font size — only the column decision needs to
  // be exact, and that comes from style.left, never from a width.
  const layerRect = div.getBoundingClientRect();
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const items = spans.map((span) => {
    const sl = num(span.style.left);
    const st = num(span.style.top);
    const rect = sl === null || st === null ? span.getBoundingClientRect() : null;
    const size = num(span.style.fontSize) ?? 12;
    return {
      span,
      node: span.firstChild,
      data: span.firstChild.data,
      top: st ?? rect.top - layerRect.top,
      left: sl ?? rect.left - layerRect.left,
      size,
      w: span.firstChild.data.length * size * 0.5, // estimate, used for run splitting only
    };
  });
  const sizes = items.map((i) => i.size).sort((a, b) => a - b);
  const line = sizes[Math.floor(sizes.length / 2)] || 12;
  const pageWidth = div.clientWidth || Math.max(...items.map((i) => i.left + i.w), 1);
  skipped.considered += items.length; // the spans this page actually contributed

  // 1. group into visual lines (same vertical band), sorted left→right, then split a
  //    band into runs wherever there is a wide horizontal gap — two columns share a
  //    band, and merging them here would defeat the column detection below.
  const runs = [];
  for (const it of items.slice().sort((a, b) => a.top - b.top || a.left - b.left)) {
    const cur = runs[runs.length - 1];
    const sameBand = cur && Math.abs(it.top - cur.top) <= line * 0.6;
    const gapX = cur ? it.left - cur.right : 0;
    if (sameBand && gapX <= line * 1.5) {
      cur.items.push(it);
      cur.right = Math.max(cur.right, it.left + it.w);
      cur.top = Math.min(cur.top, it.top);
    } else {
      runs.push({
        top: it.top,
        items: [it],
        right: it.left + it.w,
      });
    }
  }
  for (const ln of runs) ln.items.sort((a, b) => a.left - b.left);
  const lines = runs;

  // 2. column detection by clustering the line starts: real columns show up as
  //    clusters of x positions (a two-column paper has two). Each line is assigned
  //    the cluster its start falls into, so ordering by (cluster, top) reads one
  //    column top-to-bottom, then the next — and a right→left transition between
  //    bands can never be mistaken for a continuation.
  const startsSorted = lines.map((ln) => ln.items[0].left).sort((a, b) => a - b);
  const bounds = []; // cluster boundaries: the first x of each new cluster
  for (const x of startsSorted) {
    if (!bounds.length || x - bounds[bounds.length - 1] > pageWidth * 0.12) bounds.push(x);
  }
  for (const ln of lines) {
    let col = 0;
    for (let i = 0; i < bounds.length; i++) if (ln.items[0].left >= bounds[i] - 1) col = i;
    ln.column = col;
  }
  const ordered = lines.slice().sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || a.top - b.top);
  // Guard against a false split (a centred heading, an indented list): only trust a
  // column order when every cluster really holds several lines.
  const colCounts = new Map();
  for (const ln of ordered) colCounts.set(ln.column ?? 0, (colCounts.get(ln.column ?? 0) ?? 0) + 1);
  const trustworthy = colCounts.size > 1 && [...colCounts.values()].every((count) => count >= 2);
  const finalLines = trustworthy ? ordered : lines;
  const out = [];
  let text = "";
  let segments = [];
  let lastTop = null;
  let lastColumn = 0;

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed.length >= MIN_BLOCK_CHARS) {
      const key = trimmed.replace(/\s+/g, " ").toLowerCase().slice(0, 160);
      if (!seen.has(key)) {
        seen.add(key);
        const id = `p${registry.size}`;
        const section = `Page ${n}`;
        registry.set(id, {
          // The first span of the block: the most precise scroll target there is.
          element: segments[0]?.node?.parentElement ?? div,
          text,
          segments,
          section,
        });
        out.push({ id, text });
        const row = sections.find((s) => s.name === section);
        if (row) row.count++;
        else sections.push({ name: section, count: 1 });
      } else {
        skipped.dedupe++;
      }
    } else if (trimmed.length) {
      skipped.short++;
    }
    text = "";
    segments = [];
  };

  for (const ln of finalLines) {
    const gap = lastTop === null ? 0 : ln.top - lastTop;
    // A column change closes the block (only meaningful when the column split was
    // trusted; otherwise the page's own reading order is kept as-is).
    const columnChanged = trustworthy && (ln.column ?? 0) !== lastColumn;
    // A paragraph gap or a new column closes the block before this line joins it.
    if (text && (gap > line * 1.9 || columnChanged)) flush();
    for (const it of ln.items) {
      const tooLong = text && text.length + it.data.length > CHUNK_MAX_CHARS;
      if (tooLong) flush();
      // De-hyphenate a line break: the hyphen goes away, so the word reads whole
      // ("trans-" + "former" → "transformer", "café-" + "teria" → "caféteria").
      // \p{L} covers accented and non-Latin letters, not just A–Z.
      const prevEndsHyphen = text.endsWith("-") && /^\p{L}/u.test(it.data);
      let start;
      if (!text.length) {
        start = 0;
      } else if (prevEndsHyphen) {
        text = text.slice(0, -1); // drop the hyphen
        const prev = segments[segments.length - 1];
        if (prev) prev.end = Math.min(prev.end, text.length);
        start = text.length;
      } else {
        text += " ";
        start = text.length;
      }
      segments.push({ node: it.node, start, end: start + it.data.length, base: 0 });
      text += it.data;
    }
    lastTop = ln.top;
    lastColumn = ln.column ?? 0;
  }
  flush();
  return out;
}

async function main() {
  if (!src) {
    fail("No PDF address given", "Open a PDF tab and click the Tracky icon, or use the extension's toolbar button.");
    return;
  }
  let bytes;
  try {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    const file = /^file:/i.test(src);
    fail(
      "Could not read this PDF",
      file
        ? `${e.message}. For a PDF on your disk, turn on “Allow access to file URLs” in chrome://extensions → Tracky → Details, then reopen this tab.`
        : `${e.message}. Tracky needs permission for this PDF's address — click the Tracky icon on the PDF tab and choose Allow.`,
    );
    return;
  }

  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  } catch (e) {
    // A password-protected file is a normal thing to meet, not a broken PDF.
    const password = e?.name === "PasswordException" || /password/i.test(String(e?.message ?? ""));
    fail(
      password ? "This PDF is password-protected" : "This file did not open as a PDF",
      password
        ? "Tracky can't read a locked PDF — it never guesses at a password. Save an unlocked copy and open that."
        : String(e?.message || e),
    );
    return;
  }

  ui.title.textContent = `Rendering ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}…`;
  ui.name.textContent = name;
  // Target width, measured once; each page computes its own scale from it so a
  // document with mixed page sizes still fits the window.
  const width = Math.max(320, Math.min(900, window.innerWidth - 120));

  const registry = new Map();
  const seen = new Set();
  const sections = [];
  const blocks = [];
  const pages = new Map();
  const skipped = { short: 0, dedupe: 0, capped: 0, cappedPages: 0, pageErrors: 0, considered: 0 };
  const t0 = performance.now();
  let chars = 0;

  for (let n = 1; n <= doc.numPages; n++) {
    try {
      const entry = await buildPage(doc, n, width);
      pages.set(n, entry);
      ui.msg.textContent = `page ${n} of ${doc.numPages}`;
      ui.bar.style.width = `${Math.round((n / doc.numPages) * 100)}%`;
      if (blocks.length < MAX_BLOCKS && chars < MAX_CHARS) {
        const pageBlocks = blocksFromPage(entry.wrap, n, registry, seen, sections, skipped);
        for (const b of pageBlocks) {
          if (blocks.length >= MAX_BLOCKS || chars >= MAX_CHARS) {
            skipped.capped++; // counted per dropped block, not once per page
            continue;
          }
          blocks.push(b);
          chars += b.text.length;
        }
      } else {
        skipped.cappedPages++; // the cap was reached earlier: this page's text is dropped
      }
    } catch (err) {
      // One unreadable page must not cost the whole document: note it and go on.
      skipped.pageErrors++;
    }
    // Yield so the progress bar paints on long documents.
    await new Promise((r) => requestAnimationFrame(r));
  }

  // The same fingerprint the HTML collector publishes, over the same kind of text,
  // so the panel's cache can tell "same document" from "same size, different text".
  let hash = 2166136261 >>> 0;
  for (const b of blocks) {
    for (let i = 0; i < b.text.length; i++) {
      hash = (hash ^ b.text.charCodeAt(i)) >>> 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }

  const stats = {
    considered: skipped.short + skipped.dedupe + skipped.capped + blocks.length, // chunks considered
    skipped: skipped.short + skipped.dedupe + skipped.capped,
    skippedDetail: skipped,
    blocks: blocks.length, // document totals; collect() reports what it actually returned
    chars,
    totalBlocks: blocks.length,
    totalChars: chars,
    hash, // over the whole document, so the panel's cache sees one identity per document
    hashScope: "document",
    ms: Math.round(performance.now() - t0),
    pages: doc.numPages,
    spans: skipped.considered, // text-layer spans the collector actually used
    rendering: false, // the stub says true while pdf.js is still working
  };
  window.__trackyPdfReady = true;
  window.__trackyPdfStats = stats;
  window.__trackyCollect = function collect(opts = {}) {
    const cap = Number.isInteger(opts?.maxBlocks) && opts.maxBlocks > 0 ? Math.min(opts.maxBlocks, MAX_BLOCKS) : MAX_BLOCKS;
    const returned = cap >= blocks.length ? blocks : blocks.slice(0, cap);
    return {
      blocks: returned,
      // blocks/chars describe the call; totalBlocks/totalChars describe the document.
      // maxBlocks is reported per call (exactly like the stub does), so identical
      // calls produce identical stats from either collector.
      stats: {
        ...stats,
        blocks: returned.length,
        chars: returned.reduce((n, b) => n + b.text.length, 0),
        maxBlocks: cap,
      },
      byId: registry,
      sections,
    };
  };
  lazyPaint(pages);

  ui.meta.textContent = `${doc.numPages} page${doc.numPages === 1 ? "" : "s"} · ${blocks.length} passages`;
  ui.load.classList.add("gone");

  // Slide the document left while the panel is open so the two never overlap. The
  // gap is measured from the panel itself (published as --panel-w), and if the panel's
  // host is not in the DOM yet we keep checking briefly instead of silently giving up.
  const sync = () => {
    const host = document.getElementById("tracky-root");
    const wrap = host?.shadowRoot?.querySelector(".wrap");
    const panel = host?.shadowRoot?.querySelector(".panel");
    // Any way of hiding counts: inline style, a class, the hidden attribute, or CSS.
    const hidden =
      !wrap ||
      wrap.style.display === "none" ||
      wrap.classList.contains("hidden") ||
      wrap.hidden === true ||
      getComputedStyle(wrap).display === "none";
    const open = !hidden;
    document.body.classList.toggle("panel-open", open);
    if (open && panel) {
      const w = Math.round(panel.getBoundingClientRect().width);
      if (w > 0) document.body.style.setProperty("--panel-w", `${w}px`); // never stale
    }
  };
  let tries = 0;
  const attach = () => {
    const host = document.getElementById("tracky-root");
    if (host?.shadowRoot) {
      // Watch both style and class: the panel may hide itself either way, and a
      // heartbeat below keeps the layout honest even if nothing fires.
      new MutationObserver(sync).observe(host.shadowRoot, {
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
      });
      sync();
      return;
    }
    if (tries++ < 40) setTimeout(attach, 250); // content.js may still be loading
    else setTimeout(attach, 3000); // …and if it is very slow, keep checking anyway
  };
  attach();
  // A cheap safety net with a backoff: two seconds while the panel may still be
  // loading, ten seconds after that, and nothing at all while the tab is hidden.
  // (One property read each time — but there is no reason to do it forever.)
  let beats = 0;
  let timer = setInterval(() => {
    if (document.visibilityState === "visible") sync();
    if (++beats === 20) {
      clearInterval(timer);
      timer = setInterval(() => {
        if (document.visibilityState === "visible") sync();
      }, 10_000);
    }
  }, 2000);
  window.addEventListener("resize", sync, { passive: true });
}

main().catch((e) => fail("Something went wrong opening this PDF", String(e.message || e)));
