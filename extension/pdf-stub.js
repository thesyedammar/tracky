// Tracky — synchronous collector stub for the PDF page.
//
// It must be a real file (MV3's CSP forbids inline scripts) and it must exist
// before content.js, so a search started in the first seconds — while pdf.js is
// still rendering — gets an honest "nothing readable yet" answer instead of a
// crash. pdf-viewer.js replaces this with the real collector once pages are up.
window.__trackyPdfReady = false;
window.__trackyCollect = function collectStub() {
  return {
    blocks: [],
    stats: { considered: 0, skipped: 0, blocks: 0, chars: 0, hash: 0, ms: 0, rendering: true },
    byId: new Map(),
    sections: [],
  };
};
