// Tracky — page collector. Injected together with content.js into the page's
// isolated world. Walks the DOM once and returns readable text blocks, each with
// an exact char-range map back to its text nodes, so a sentence offset returned
// by the helper can later be highlighted without re-parsing the page.

(() => {
  if (window.__trackyCollect) return;

  const BLOCK_SELECTOR =
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, td, th, figcaption, pre, summary, caption";
  const CONTAINER_TAGS = new Set(["DIV", "SECTION", "ARTICLE", "MAIN"]);
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "CANVAS", "SVG", "VIDEO",
    "AUDIO", "OBJECT", "EMBED", "MAP", "TEXTAREA", "INPUT", "SELECT", "BUTTON",
    "OPTION", "LABEL", "CODE", "KBD", "SAMP",
  ]);
  const SKIP_STRUCT = new Set(["NAV", "FOOTER", "ASIDE", "FORM", "DIALOG", "MENU"]);
  const SKIP_ROLES = new Set([
    "navigation", "banner", "contentinfo", "complementary", "search",
    "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist",
  ]);
  const MIN_BLOCK_CHARS = 40;
  const MAX_BLOCKS = 600; // contract: the extension sends at most 600 passages
  const MAX_CHARS = 400_000;
  const MAX_BLOCK_CHARS = 20_000;
  /** The contract's hard cap per passage (server/validate.mjs `passageMax`, mirrored in
   *  extension/direct.js). A block over this used to be sent whole and REFUSED by the
   *  validator — one long paragraph killed the entire search — so anything longer is
   *  split at sentence ends before it is sent. */
  const PASSAGE_MAX = 2200;

  /** Concatenate text nodes exactly, recording where each node lands. <br> becomes a synthetic \n. */
  function extractText(root) {
    const segments = [];
    let out = "";
    const skipEl = (el) => {
      const tag = (el.tagName || "").toUpperCase(); // SVG elements report lowercase
      if (SKIP_TAGS.has(tag) || SKIP_STRUCT.has(tag)) return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
      const role = el.getAttribute("role");
      return !!(role && SKIP_ROLES.has(role));
    };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.data;
        if (!data) return;
        segments.push({ node, start: out.length, end: out.length + data.length, base: 0 });
        out += data;
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (skipEl(node)) return;
        if (node.tagName === "BR") {
          segments.push({ synthetic: true, start: out.length, end: out.length + 1 });
          out += "\n";
          return;
        }
        for (const child of node.childNodes) walk(child);
      }
    };
    for (const child of root.childNodes) walk(child);
    return { text: out, segments };
  }

  /** Trim whitespace while keeping the segment map exact (offsets rebased, node
   *  base offsets preserved so a sentence starting inside a partially-trimmed
   *  text node still maps to the right character). */
  function trimmedView(text, segments) {
    const start = text.length - text.trimStart().length;
    const end = text.trimEnd().length;
    const segs = [];
    for (const s of segments) {
      const a = Math.max(s.start, start);
      const b = Math.min(s.end, end);
      if (b <= a) continue;
      const base = (s.base ?? 0) + (a - s.start); // node offset of the first kept char
      segs.push({ ...s, start: a - start, end: b - start, base });
    }
    return { text: text.slice(start, end), segments: segs };
  }

  /** Split `text` into pieces of ≤ PASSAGE_MAX chars, preferring a sentence end, then a
   *  space, then a hard cut (for text with no break at all). Offsets stay exact: each
   *  piece carries its own segment map, rebased onto the piece, so a sentence found in
   *  piece 3 still highlights the right characters on the page. */
  function splitForContract(text, segments) {
    if (text.length <= PASSAGE_MAX) return [{ text, segments, start: 0 }];
    const pieces = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + PASSAGE_MAX, text.length);
      if (end < text.length) {
        const window = text.slice(start, end);
        const at = Math.max(
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
          window.lastIndexOf(".\n"),
        );
        if (at > PASSAGE_MAX / 2) {
          end = start + at + 1; // keep the full stop with its sentence
        } else {
          const sp = window.lastIndexOf(" ");
          if (sp > 0) end = start + sp; // no sentence break: cut at a space
        }
      }
      if (end <= start) end = Math.min(start + PASSAGE_MAX, text.length); // never stall
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const pieceText = raw.trim();
      const absStart = start + lead;
      if (pieceText) {
        const absEnd = absStart + pieceText.length;
        const segs = [];
        for (const s of segments) {
          const a = Math.max(s.start, absStart);
          const b = Math.min(s.end, absEnd);
          if (b <= a) continue;
          const base = (s.base ?? 0) + (a - s.start);
          segs.push({ ...s, start: a - absStart, end: b - absStart, base });
        }
        pieces.push({ text: pieceText, segments: segs, start: absStart });
      }
      start = end;
    }
    return pieces;
  }

  const visible = (el) => {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return el.getClientRects().length > 0;
  };

  const hasDirectLongText = (el) => {
    let n = 0;
    for (const c of el.childNodes) {
      if (c.nodeType !== Node.TEXT_NODE) continue;
      const len = c.data.trim().length;
      if (len) n += len;
      if (n >= MIN_BLOCK_CHARS) return true; // early exit
    }
    return false;
  };

  window.__trackyCollect = function collect({ maxBlocks = MAX_BLOCKS, maxChars = MAX_CHARS } = {}) {
    const started = performance.now();
    const accepted = [];
    const stats = { considered: 0, skipped: 0, blocks: 0, chars: 0, hash: 0, ms: 0 };
    let hash = 2166136261 >>> 0; // FNV-1a seed

    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        const tag = (el.tagName || "").toUpperCase(); // SVG elements report lowercase
        if (SKIP_TAGS.has(tag) || SKIP_STRUCT.has(tag)) return NodeFilter.FILTER_REJECT;
        const role = el.getAttribute("role");
        if (role && SKIP_ROLES.has(role)) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute("aria-hidden") === "true") return NodeFilter.FILTER_REJECT;
        if (el.matches(BLOCK_SELECTOR)) {
          stats.considered++;
          if (visible(el)) accepted.push(el);
          else stats.skipped++;
          return NodeFilter.FILTER_REJECT; // prune: never collect nested duplicates
        }
        // Container fallback: cheap test first (direct text) so the querySelector
        // only runs for the handful of real candidates — measured 4–7 ms per
        // Wikipedia article, not O(N²) in practice.
        if (CONTAINER_TAGS.has(tag) && hasDirectLongText(el) && !el.querySelector(BLOCK_SELECTOR)) {
          stats.considered++;
          if (visible(el)) accepted.push(el);
          else stats.skipped++;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()); // the acceptNode callback does the work

    const registry = new Map();
    const blocks = [];
    const seen = new Set();
    const sections = []; // ordered [{ name, count }] — headings are the section names
    const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
    let currentSection = null;
    for (const el of accepted) {
      if (blocks.length >= maxBlocks || stats.chars >= maxChars) break;
      const extracted = extractText(el);
      const { text, segments } = trimmedView(extracted.text, extracted.segments);
      const trimmed = text.trim();
      // A heading opens a new section — set before the length checks so a short
      // heading still names the section it starts.
      if (HEADING_TAGS.has((el.tagName || "").toUpperCase())) {
        currentSection = trimmed.replace(/\s+/g, " ").slice(0, 60) || null;
        if (currentSection) sections.push({ name: currentSection, count: 0 });
      }
      if (trimmed.length < MIN_BLOCK_CHARS) {
        stats.skipped++;
        continue;
      }
      const key = trimmed.replace(/\s+/g, " ").toLowerCase().slice(0, 160);
      if (seen.has(key)) {
        stats.skipped++;
        continue;
      }
      seen.add(key);
      // Clip monster blocks, and clip the segment map with them so highlight
      // offsets can never point past the text we actually sent.
      let clippedText = text;
      let clippedSegs = segments;
      if (text.length > MAX_BLOCK_CHARS) {
        clippedText = text.slice(0, MAX_BLOCK_CHARS);
        clippedSegs = segments
          .map((s) => ({ ...s, end: Math.min(s.end, MAX_BLOCK_CHARS) }))
          .filter((s) => s.start < MAX_BLOCK_CHARS && s.end > s.start);
      }
      // Anything still over the contract's cap becomes several passages: one long
      // paragraph used to be sent whole and fail the whole search at the validator.
      for (const piece of splitForContract(clippedText, clippedSegs)) {
        if (blocks.length >= maxBlocks) break;
        const id = `p${blocks.length}`;
        blocks.push({ id, text: piece.text });
        registry.set(id, { element: el, text: piece.text, segments: piece.segments, section: currentSection });
        if (currentSection) {
          const s = sections.find((x) => x.name === currentSection);
          if (s) s.count++;
        }
        stats.chars += piece.text.length;
        // FNV-1a over every block's text: a cheap content fingerprint so the panel can
        // tell "same page" from "same size, different content" when keying its cache.
        for (let i = 0; i < piece.text.length; i++) {
          hash = (hash ^ piece.text.charCodeAt(i)) >>> 0;
          hash = Math.imul(hash, 16777619) >>> 0;
        }
      }
    }

    stats.blocks = blocks.length;
    stats.hash = hash;
    stats.ms = Math.round(performance.now() - started);
    window.__trackyBlocks = registry; // handy for debugging; the return value is the contract
    window.__trackySplitForContract = splitForContract; // same: debug + tests
    window.__trackyExtractText = extractText; // same: debug + tests
    return { blocks, stats, byId: registry, sections };
  };
})();
