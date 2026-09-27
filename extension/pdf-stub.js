// Tracky — synchronous collector stub for the PDF page.
//
// It must be a real file (MV3's CSP forbids inline scripts) and it must exist
// before content.js, so a search started in the first seconds — while pdf.js is
// still rendering — gets an honest "nothing readable yet" answer instead of a
// crash. pdf-viewer.js replaces it with the real collector once pages are up, and
// the shape here is deliberately identical to collect.js (same keys, same stats
// fields, same maxBlocks option) so nothing downstream can tell the difference.
// The collector's document cap, defined once here because this file is loaded before
// pdf-viewer.js — the real collector reads it instead of keeping its own copy.
window.__trackyMaxBlocks = 600;

window.__trackyPdfReady = false;
window.__trackyCollect = function collectStub(opts = {}) {
  // Same clamp as the real collector, so identical calls return identical stats.
  const raw = opts?.maxBlocks;
  const cap = Number.isInteger(raw) && raw > 0 ? Math.min(raw, window.__trackyMaxBlocks) : window.__trackyMaxBlocks;
  return {
    blocks: [],
    stats: {
      chunksConsidered: 0,
      skipped: 0,
      skippedDetail: { short: 0, dedupe: 0, capped: 0, cappedPages: 0, pageErrors: 0, considered: 0 },
      blocks: 0,
      chars: 0,
      totalBlocks: 0,
      totalChars: 0,
      hash: 0,
      hashScope: "document",
      ms: 0,
      pages: 0,
      spans: 0,
      maxBlocks: cap,
      rendering: true, // the panel can say "still rendering" instead of "no text"
    },
    byId: new Map(),
    sections: [],
  };
};
