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
const MAX_BLOCK_CHARS = 20_000;

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
  ui.msg.innerHTML = `<span class="err">${message}</span>`;
  ui.bar.parentElement.style.display = "none";
}

ui.name.textContent = name;
ui.name.title = src;

/** Build the page element (canvas + text layer) for one page. */
async function renderPage(doc, n, scale) {
  const page = await doc.getPage(n);
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
  wrap.appendChild(canvas);

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  textLayerDiv.style.setProperty("--scale-factor", viewport.scale);
  wrap.appendChild(textLayerDiv);
  el("pages").appendChild(wrap);

  await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;

  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
  page.cleanup();
  return wrap;
}

/** Group a page's text-layer spans into paragraph-ish blocks with exact offsets.
 *
 *  The block text is built from the DOM spans themselves (joined with a single
 *  space), so every character we send is a character that exists in the text
 *  layer — and every returned sentence maps back to the exact span range that
 *  painted it. That is the same never-fabricate guarantee the HTML path has. */
function blocksFromPage(wrap, n, registry, seen, sections) {
  const div = wrap.querySelector(".textLayer");
  if (!div) return [];
  const spans = [...div.querySelectorAll("span")].filter(
    (s) => s.firstChild && s.firstChild.nodeType === Node.TEXT_NODE && s.firstChild.data.length > 0,
  );
  if (!spans.length) return [];

  const tops = spans.map((s) => parseFloat(s.style.top) || 0);
  const sizes = spans.map((s) => parseFloat(s.style.fontSize) || 12).sort((a, b) => a - b);
  const line = sizes[Math.floor(sizes.length / 2)] || 12;

  const out = [];
  let text = "";
  let segments = [];
  let lastTop = null;

  const flush = () => {
    const trimmed = text.trim();
    if (trimmed.length >= MIN_BLOCK_CHARS) {
      const key = trimmed.replace(/\s+/g, " ").toLowerCase().slice(0, 160);
      if (!seen.has(key)) {
        seen.add(key);
        const clipped = text.length > MAX_BLOCK_CHARS ? text.slice(0, MAX_BLOCK_CHARS) : text;
        const segs =
          text.length > MAX_BLOCK_CHARS
            ? segments.map((s) => ({ ...s, end: Math.min(s.end, MAX_BLOCK_CHARS) })).filter((s) => s.start < MAX_BLOCK_CHARS && s.end > s.start)
            : segments;
        const id = `p${registry.size}`;
        const section = `Page ${n}`;
        registry.set(id, { element: segments[0]?.node?.parentElement ?? div, text: clipped, segments: segs, section });
        out.push({ id, text: clipped });
        const row = sections.find((s) => s.name === section);
        if (row) row.count++;
        else sections.push({ name: section, count: 1 });
      }
    }
    text = "";
    segments = [];
  };

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const data = span.firstChild.data;
    const top = tops[i];
    const gap = lastTop === null ? 0 : top - lastTop;
    // A new paragraph when the gap is bigger than ~two lines, or when the block
    // has grown past a comfortable chunk.
    if (text && (gap > line * 1.9 || text.length + data.length > 1400)) flush();
    const start = text.length ? text.length + 1 : 0; // the join space belongs to no span
    if (text.length) text += " ";
    segments.push({ node: span.firstChild, start, end: start + data.length, base: 0 });
    text += data;
    lastTop = top;
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
    fail("This file did not open as a PDF", String(e.message || e));
    return;
  }

  ui.title.textContent = `Rendering ${doc.numPages} page${doc.numPages === 1 ? "" : "s"}…`;
  ui.name.textContent = name;
  const width = Math.max(320, Math.min(900, window.innerWidth - 120));
  const first = await doc.getPage(1);
  const scale = width / first.getViewport({ scale: 1 }).width;
  first.cleanup();

  const registry = new Map();
  const seen = new Set();
  const sections = [];
  const blocks = [];
  let chars = 0;

  for (let n = 1; n <= doc.numPages; n++) {
    const wrap = await renderPage(doc, n, scale);
    ui.msg.textContent = `page ${n} of ${doc.numPages}`;
    ui.bar.style.width = `${Math.round((n / doc.numPages) * 100)}%`;
    if (blocks.length < MAX_BLOCKS && chars < MAX_CHARS) {
      const pageBlocks = blocksFromPage(wrap, n, registry, seen, sections);
      for (const b of pageBlocks) {
        if (blocks.length >= MAX_BLOCKS || chars >= MAX_CHARS) break;
        blocks.push(b);
        chars += b.text.length;
      }
    }
    // Yield so the progress bar paints on long documents.
    await new Promise((r) => requestAnimationFrame(r));
  }

  const stats = {
    considered: blocks.length,
    skipped: 0,
    blocks: blocks.length,
    chars,
    hash: 0,
    ms: 0,
    pages: doc.numPages,
  };
  window.__trackyPdfReady = true;
  window.__trackyPdfStats = stats;
  window.__trackyCollect = function collect() {
    return { blocks, stats, byId: registry, sections };
  };

  ui.meta.textContent = `${doc.numPages} page${doc.numPages === 1 ? "" : "s"} · ${blocks.length} passages`;
  ui.load.classList.add("gone");

  // Slide the document left while the panel is open so the two never overlap.
  // Watching the panel's own shadow root is exact — no polling, no guesswork.
  const host = document.getElementById("tracky-root");
  const sync = () => {
    const wrap = host?.shadowRoot?.querySelector(".wrap");
    document.body.classList.toggle("panel-open", !!wrap && wrap.style.display !== "none");
  };
  if (host?.shadowRoot) {
    new MutationObserver(sync).observe(host.shadowRoot, { subtree: true, attributes: true, attributeFilter: ["style"] });
    sync();
  }
}

main().catch((e) => fail("Something went wrong opening this PDF", String(e.message || e)));
