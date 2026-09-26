// Tracky — panel content script, injected on demand (icon click / Alt+K).
//
// Everything lives inside a shadow root, so page CSS can never leak in and our
// styles can never touch the page. The panel pings the background worker, which
// is the only component that talks to the local helper.

(() => {
  const VERSION = chrome.runtime.getManifest().version;

  // Re-injection (second click): just reopen the existing panel.
  if (window.__tracky) {
    window.__tracky.open();
    return;
  }
  // Extension reloaded while the page stayed open: drop the orphaned host first.
  const stale = document.getElementById("tracky-root");
  if (stale) stale.remove();

  const host = document.createElement("div");
  host.id = "tracky-root";
  host.setAttribute("data-tracky", "panel");
  // Inline + !important on the host itself: page CSS can never hide or restyle it
  // (page rules beat shadow :host rules, but nothing beats inline !important).
  // Deliberately no `contain` — it would become the containing block for the
  // fixed-position panel inside.
  host.style.setProperty("all", "initial", "important");
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("top", "0", "important");
  host.style.setProperty("right", "0", "important");
  host.style.setProperty("width", "0", "important");
  host.style.setProperty("height", "0", "important");
  host.style.setProperty("z-index", "2147483647", "important");
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 360px;
        font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #E9EDF5;
      }
      .panel {
        background: rgba(12, 17, 27, .94);
        border: 1px solid rgba(255, 255, 255, .09);
        border-radius: 14px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .35);
        animation: tIn 140ms cubic-bezier(.2, .9, .3, 1);
      }
      @keyframes tIn { from { opacity: 0; transform: translateY(-6px) scale(.985); } }
      header { display: flex; align-items: center; gap: 8px; padding: 11px 12px 9px; }
      .mark {
        width: 16px; height: 16px; border-radius: 5px; flex: none;
        background: linear-gradient(135deg, #F5C453, #E19B2C);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14);
      }
      .name { font-weight: 650; letter-spacing: .2px; }
      .ver { color: #8A94A6; font-size: 11px; margin-left: 5px; }
      .spacer { flex: 1; }
      .close {
        appearance: none; border: 0; background: transparent; color: #8A94A6;
        font-size: 15px; line-height: 1; cursor: pointer; padding: 4px 6px; border-radius: 8px;
      }
      .close:hover { background: rgba(255, 255, 255, .07); color: #E9EDF5; }
      .close:focus-visible, input:focus-visible { outline: 2px solid rgba(245, 196, 83, .65); outline-offset: 1px; }
      .box { display: flex; gap: 6px; padding: 0 12px 12px; }
      input[type="text"] {
        flex: 1; min-width: 0; box-sizing: border-box; background: rgba(255, 255, 255, .05);
        border: 1px solid rgba(255, 255, 255, .10); border-radius: 10px;
        color: #E9EDF5; padding: 9px 11px; font: inherit;
      }
      input::placeholder { color: #7C8698; }
      .rescan {
        flex: none; width: 34px; appearance: none; border-radius: 10px; cursor: pointer;
        border: 1px solid rgba(255, 255, 255, .10); background: rgba(255, 255, 255, .05);
        color: #AAB3C2; font: 14px/1 ui-monospace, monospace;
      }
      .rescan:hover { background: rgba(255, 255, 255, .09); color: #E9EDF5; }
      .rescan:focus-visible, .scope-chip:focus-visible, .recent-chip:focus-visible,
      .export:focus-visible, .copy:focus-visible, .chip:focus-visible {
        outline: 2px solid rgba(245, 196, 83, .65); outline-offset: 1px;
      }
      .recent { display: flex; gap: 6px; padding: 0 12px 9px; overflow-x: auto; scrollbar-width: none; }
      .recent[hidden] { display: none; }
      .recent::-webkit-scrollbar { display: none; }
      .recent-chip {
        flex: none; appearance: none; border: 1px dashed rgba(255, 255, 255, .14); background: transparent;
        color: #98A2B3; font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
        white-space: nowrap; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
      }
      .recent-chip:hover { color: #E9EDF5; border-color: rgba(255, 255, 255, .28); }
      .sr {
        position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
        clip: rect(0 0 0 0); white-space: nowrap; border: 0;
      }
      /* The one and only reduced-motion block: no entrance animation, no pulse, no transitions. */
      @media (prefers-reduced-motion: reduce) {
        .panel, .dot.wait { animation: none !important; }
        .hit, .wrap, .dot, .jump, .recent-chip, .chip { transition: none !important; }
      }
      .status {
        display: flex; align-items: center; gap: 9px; padding: 10px 12px 12px;
        border-top: 1px solid rgba(255, 255, 255, .06); color: #C3CBD9; font-size: 12.5px;
        line-height: 1.45;
      }
      /* When the status is a failure, say so with more than a dot: brighter text and
         a tinted strip, so the most important line in the panel cannot be missed. */
      .status:has(.dot.bad) { color: #FFD9D9; background: rgba(242, 109, 109, .06); }
      .retry {
        margin-left: auto; flex: none; appearance: none; cursor: pointer;
        font: 11.5px/1 ui-sans-serif, system-ui, sans-serif; color: #FFE4E4;
        background: rgba(242, 109, 109, .2); border: 1px solid rgba(242, 109, 109, .55);
        border-radius: 999px; padding: 4px 10px;
      }
      .retry:hover { background: rgba(242, 109, 109, .3); border-color: rgba(242, 109, 109, .75); }
      .retry:focus-visible { outline: 2px solid rgba(245, 196, 83, .65); outline-offset: 1px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8A94A6; flex: none; }
      .dot.ok { background: #3ECF8E; box-shadow: 0 0 0 3px rgba(62, 207, 142, .15); }
      .dot.bad { background: #F26D6D; box-shadow: 0 0 0 3px rgba(242, 109, 109, .15); }
      .dot.idle { background: #8A94A6; }
      .dot.wait { background: #F5C453; animation: tPulse 1.1s ease-in-out infinite; }
      @keyframes tPulse { 50% { opacity: .35; } }
      .hint { color: #8D97A8; font-size: 11.5px; line-height: 1.6; padding: 2px 12px 12px; }
      kbd { background: rgba(255, 255, 255, .08); border-radius: 4px; padding: 1px 5px; font: 10px ui-monospace, monospace; }
      .results { display: none; max-height: 320px; overflow: auto; padding: 2px 12px 10px; }
      .results.open { display: block; }
      .hit {
        padding: 8px 10px; border-radius: 10px; margin-bottom: 7px;
        background: rgba(255, 255, 255, .04); border: 1px solid rgba(255, 255, 255, .06);
      }
      .hit:last-child { margin-bottom: 2px; }
      .hit { position: relative; padding-right: 34px; transition: background 120ms ease, border-color 120ms ease; }
      .hit:hover { background: rgba(255, 255, 255, .07); border-color: rgba(255, 255, 255, .13); }
      .hit.selected { border-color: rgba(245, 196, 83, .45); background: rgba(245, 196, 83, .08); }
      .hit .jump {
        appearance: none; border: 0; background: transparent; color: inherit; font: inherit;
        text-align: left; width: 100%; padding: 0; cursor: pointer; display: block;
      }
      .hit .jump:focus-visible { outline: 2px solid rgba(245, 196, 83, .65); outline-offset: 2px; border-radius: 6px; }
      .hit .rank { display: inline-block; min-width: 12px; margin-right: 6px; color: #66707F; font-size: 11px; font-variant-numeric: tabular-nums; }
      .hit .score { display: inline-block; min-width: 36px; margin-right: 7px; color: #F5C453; font-weight: 650; font-variant-numeric: tabular-nums; }
      .hit .sentence { color: #DEE5EF; }
      .hit .copy {
        position: absolute; top: 5px; right: 5px; appearance: none; border: 0; background: transparent;
        color: #8A94A6; cursor: pointer; padding: 4px 6px; border-radius: 7px; line-height: 0;
        opacity: 0; transition: opacity 120ms ease;
      }
      .hit:hover .copy, .hit .copy:focus-visible { opacity: 1; }
      .hit .copy:hover { background: rgba(255, 255, 255, .1); color: #E9EDF5; }
      @media (hover: none) { .hit .copy { opacity: 1; } }
      .empty { color: #8A94A6; padding: 8px 2px 4px; }
      .empty .tip { color: #7C8698; font-size: 11px; margin-top: 4px; }
      .scope { display: flex; gap: 6px; padding: 0 12px 10px; overflow-x: auto; }
      .scope[hidden] { display: none; }
      .scope::-webkit-scrollbar { display: none; }
      .scope-chip {
        flex: none; appearance: none; border: 1px solid rgba(255, 255, 255, .1); background: rgba(255, 255, 255, .04);
        color: #AAB3C2; font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 999px; cursor: pointer; white-space: nowrap;
      }
      .scope-chip:hover { background: rgba(255, 255, 255, .08); color: #E9EDF5; }
      .scope-chip.on { border-color: rgba(245, 196, 83, .5); background: rgba(245, 196, 83, .12); color: #F5C453; }
      .scope-chip .n { opacity: .6; }
      .card {
        margin: 2px 0 10px; padding: 10px 11px; border-radius: 12px;
        background: linear-gradient(180deg, rgba(245, 196, 83, .10), rgba(245, 196, 83, .03));
        border: 1px solid rgba(245, 196, 83, .25);
      }
      .card-title { font-size: 10px; letter-spacing: .5px; text-transform: uppercase; color: #F5C453; margin-bottom: 7px; }
      .card-line { display: flex; gap: 8px; margin-bottom: 6px; }
      .card-line:last-of-type { margin-bottom: 2px; }
      .card-sentence { color: #EDF1F7; }
      .chip {
        flex: none; min-width: 17px; height: 17px; appearance: none; border-radius: 6px;
        background: rgba(245, 196, 83, .16); border: 1px solid rgba(245, 196, 83, .4); color: #F5C453;
        font: 650 10px/1 ui-monospace, monospace; display: inline-flex; align-items: center;
        justify-content: center; cursor: pointer; padding: 0 4px;
      }
      .chip:hover { background: rgba(245, 196, 83, .28); }
      .card-foot { color: #8A94A6; font-size: 11px; margin-top: 5px; }
      .group { color: #7C8698; font-size: 10px; letter-spacing: .5px; text-transform: uppercase; padding: 8px 2px 6px; }
      .hit .tag { display: inline-block; min-width: 36px; margin-right: 7px; color: #9FB4D8; font-size: 11px; font-weight: 600; }
      .hit .why { display: block; margin: 5px 0 0 19px; color: #9CC6A9; font-size: 11px; }
      .hit .why[hidden] { display: none; }
      .results-foot { padding: 5px 0 2px; }
      .export {
        appearance: none; border: 1px solid rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .04);
        color: #AAB3C2; font: inherit; font-size: 11px; padding: 5px 10px; border-radius: 8px; cursor: pointer;
      }
      .export:hover { background: rgba(255, 255, 255, .08); color: #E9EDF5; }
      .results::-webkit-scrollbar { width: 8px; }
      .results::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .14); border-radius: 8px; }
      /* Cross-tab (Phase 14): opt-in, so the toggle only appears when the options
         page has enabled it. Other tabs' hits are a separate section, each labelled
         with its tab — they are quotes from that tab, and clicking one goes there. */
      .xtabs { display: flex; gap: 9px; padding: 0 12px 10px; align-items: center; }
      .xtabs button { flex: none; font: 11.5px/1 ui-sans-serif, system-ui, sans-serif; color: #cfd6e4; background: rgba(255,255,255,.06);
        border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 5px 10px; cursor: pointer; }
      .xtabs button[aria-pressed="true"] { background: rgba(212,175,55,.18); border-color: rgba(212,175,55,.5); color: #F5C453; }
      .xtabs .note { font-size: 11px; color: #98A2B3; line-height: 1.4; }
      .xtab-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #9aa4b8;
        padding: 10px 12px 4px; border-top: 1px solid rgba(255,255,255,.07); margin-top: 8px; }
      .xtab-head .t { color: #cfd6e4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
      .xtab-head .u { color: #6f7a8d; font-size: 10.5px; }
      .hit.other .jump::before { content: "↗"; }
    </style>
    <div class="wrap" role="dialog" aria-label="Tracky — search this page by meaning">
      <div class="panel">
        <header>
          <div class="mark" aria-hidden="true"></div>
          <span class="name">Tracky</span><span class="ver">v${VERSION}</span>
          <div class="spacer"></div>
          <button class="close" aria-label="Close Tracky (Esc)">✕</button>
        </header>
        <div class="box">
          <input type="text" spellcheck="false" autocomplete="off"
            placeholder="Search this page by meaning…" aria-label="Search this page by meaning">
          <button class="rescan" id="t-rescan" type="button" aria-label="Re-scan this page" title="Re-scan this page (it may have changed)">⟳</button>
        </div>
        <div class="recent" id="t-recent" hidden></div>
        <div class="scope" id="t-scope" hidden></div>
        <div class="xtabs" id="t-xtabs" hidden></div>
        <div class="results" id="t-results" aria-live="off"></div>
        <div class="status" role="status" aria-live="polite">
          <span class="dot wait" id="t-dot"></span><span id="t-status">checking the helper…</span>
        </div>
        <span class="sr" id="t-sr" aria-live="polite"></span>
        <div class="hint">Finds ideas, not just letters — then quotes the exact sentences. <kbd>Enter</kbd> search · <kbd>↑↓</kbd> results · <kbd>Esc</kbd> close.</div>
      </div>
    </div>`;

  document.documentElement.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const dot = $("#t-dot");
  const statusText = $("#t-status");
  const input = $("input");
  const wrap = $(".wrap");

  const setStatus = (kind, text) => {
    dot.className = `dot ${kind}`;
    statusText.textContent = text;
    // A persistent failure gets a retry affordance: ask the same question again
    // without retyping it. (Rate limits pass, networks hiccup — a second try should
    // never cost the user their query.)
    const old = $(".retry");
    if (old) old.remove();
    if (kind === "bad") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "retry";
      b.textContent = "Retry";
      b.title = "Ask this question again";
      b.addEventListener("click", () => {
        const q = input.value.trim();
        if (q) runSearch(q);
      });
      statusText.after(b);
    }
  };

  const send = (msg, ms = 3000) => {
    // A timeout abandons the REPLY only — the background fetch keeps running to
    // completion and the helper logs it (counts only). Nothing is left half-done.
    const p = chrome.runtime.sendMessage(msg);
    p.catch(() => {}); // never unhandled, even when the timeout wins the race
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  };

  const HELP_FIX = "helper not running — start it: node server/server.mjs";

  let pingSeq = 0; // only the latest ping may write the status line
  async function ping() {
    const seq = ++pingSeq;
    clearTimeout(statusTimer); // a pending "briefly" revert must not clobber this
    setStatus("wait", "checking the helper…");
    try {
      const reply = await send({ type: "tracky:health" });
      if (seq !== pingSeq) return; // superseded by a newer ping
      const h = reply?.health;
      if (reply?.ok && typeof h?.version === "string" && typeof h?.model === "string") {
        setStatus("ok", `helper ${h.version} · ${h.model} · ready`);
      } else {
        setStatus("bad", HELP_FIX);
      }
    } catch {
      if (seq === pingSeq) setStatus("bad", HELP_FIX);
    }
  }

  let visible = false; // the markup starts shown; open() below sets this and pings
  let lastFocus = null;
  function open() {
    const prev = document.activeElement;
    // activeElement retargets to the host while focus is inside the shadow root —
    // never capture our own host (or, defensively, the input) as the element to
    // restore focus to.
    if (prev instanceof HTMLElement && prev !== input && prev !== host) lastFocus = prev;
    const wasVisible = visible;
    wrap.style.display = "";
    visible = true;
    if (isDenied()) {
      setStatus("idle", DENY_MSG);
    } else if (!wasVisible) {
      ping(); // idempotent: a re-inject + tracky:open pair pings once
    }
    input.focus({ preventScroll: true });
    renderRecent(); // the recent row belongs to an empty field
  }
  function close() {
    wrap.style.display = "none";
    visible = false;
    clearTimeout(statusTimer); // no stale revert while hidden
    clearHighlight(); // tidy: the marker belongs to the panel session
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  $(".close").addEventListener("click", close);

  document.addEventListener(
    "keydown",
    (e) => {
      // Only when the panel itself has focus (document.activeElement retargets to
      // the host while focus is inside the shadow root) — never hijack page dialogs.
      if (e.key !== "Escape" || !visible) return;
      const t = e.target;
      // A page field owns its own Esc (including <select>, which closes on Esc natively).
      const inPageField =
        t instanceof HTMLElement && (t.closest?.("input, textarea, select") || t.isContentEditable);
      const inPanel = document.activeElement === host; // focus inside the shadow root retargets here
      if (!inPanel && inPageField) return; // a page field owns its own Esc
      close();
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const resultsEl = $("#t-results");
  const showResults = (html) => {
    resultsEl.innerHTML = html;
    resultsEl.classList.toggle("open", html !== "");
  };

  const sanitizeResults = (raw) =>
    (Array.isArray(raw) ? raw : [])
      .map((r) => ({
        passageId: typeof r?.passageId === "string" ? r.passageId : "",
        sentence: typeof r?.sentence === "string" ? r.sentence : "",
        score: Math.min(1, Math.max(0, Number(r?.score))), // clamp: never render >100% or <0%
        offset: Number(r?.offset),
      }))
      .filter((r) => r.sentence.length > 0 && Number.isFinite(r.score) && r.passageId !== "")
      .slice(0, 12); // a rogue helper must never be able to bloat the panel

  const MAX_SHOWN_SENTENCE = 1200; // render cap only — the full sentence is kept for jump/copy

  let lastResults = [];
  let lastById = null; // the collector's id → block registry for this search
  let lastSections = []; // ordered page sections (heading names) for the scope chips
  let lastPassages = 0; // passages actually searched (for the export header)
  let scope = null; // active section scope, or null for the whole page
  let whyGen = 0; // why-chips generation: a stale reply must never touch a newer list
  let lastSearchKey = ""; // `${scope}::${query}` already rendered — never re-run it by accident
  let debounceTimer = null; // 700 ms live-search debounce

  // ---- Phase 9: cache, history, options, spend meter (counts only, never text) ----
  const CACHE_TTL = 10 * 60 * 1000;
  const CACHE_MAX = 24;
  const cache = new Map(); // key → { meaning, literalOnly, passages, at, why }
  const history = []; // recent queries on this page — session only, never stored
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
  const SCROLL = () => (REDUCED.matches ? "auto" : "smooth"); // motion is a preference, not a default
  // Mirror of extension/shared.js (content scripts cannot import). Both copies are
  // exercised by the smoke harness: the SW copy by a direct unit check, this one by
  // the end-to-end deny-list check. Keep them identical.
  const hostMatches = (host, h) => {
    const clean = (s) => (typeof s === "string" ? s.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "");
    const n = clean(h);
    const name = clean(host);
    return !!n && !!name && (name === n || name.endsWith(`.${n}`));
  };
  let opts = { hijackCtrlF: true, disabledHosts: [], countSearches: true };
  let xSearch = false; // include other tabs in this search (only when the option is on)
  let lastCross = null; // { tabs, passages, skipped, results } from the last cross-tab search
  let spend = null; // { date, searches, passages } — a counter, not a log
  const DENY_MSG = "Tracky is off for this site — manage it in the extension options";
  const isDenied = () => opts.disabledHosts?.some((h) => hostMatches(location.hostname, h)) ?? false;
  try {
    chrome.storage?.local?.get?.({ trackyOpts: null, trackySpend: null }, (v) => {
      if (v?.trackyOpts && typeof v.trackyOpts === "object") opts = { ...opts, ...v.trackyOpts };
      if (v?.trackySpend && typeof v.trackySpend === "object") spend = v.trackySpend;
      // The load is async, so the very first open() may have run on defaults. Re-apply
      // the deny state now that the real list is known (and un-stick it if it shrank).
      if (visible) {
        if (isDenied()) setStatus("idle", DENY_MSG);
        else if (statusText.textContent === DENY_MSG) ping();
      }
      xSearch = opts.crossTab === true; // off unless the options page turned it on
      renderXtabs();
    });
    chrome.storage?.onChanged?.addListener?.((changes) => {
      if (changes?.trackyOpts?.newValue) {
        opts = { ...opts, ...changes.trackyOpts.newValue };
        xSearch = opts.crossTab === true;
        renderXtabs();
      }
    });
  } catch {
    /* storage is optional — the panel works without it */
  }

  // ---- cross-tab (Phase 14): only ever shown when the options page turned it on ----
  function renderXtabs() {
    const box = $("#t-xtabs");
    if (!box) return;
    if (!opts.crossTab) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const note = xSearch ? "included in the next search" : "off — this page only";
    box.innerHTML = `<button type="button" id="t-xbtn" aria-pressed="${xSearch ? "true" : "false"}"
        title="Also search your other open tabs (only their text, only when you search)">Other tabs</button>
      <span class="note" id="t-xnote">${note}</span>`;
    $("#t-xbtn")?.addEventListener("click", () => {
      xSearch = !xSearch;
      renderXtabs();
      if (input.value.trim() && lastSearchKey) runSearch({ force: true });
    });
  }
  const srEl = $("#t-sr");
  const announce = (text) => {
    srEl.textContent = text;
  };
  function bumpSpend(passages) {
    if (!opts.countSearches) return;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    if (!spend || spend.date !== day) spend = { date: day, searches: 0, passages: 0 };
    spend.searches += 1;
    spend.passages += passages;
    try {
      chrome.storage?.local?.set?.({ trackySpend: spend });
    } catch {
      /* the meter is a courtesy, never a blocker */
    }
  }
  let statsLine = "";
  let statsKind = "idle";
  let statusTimer = null;

  const clip = (s) => (s.length > MAX_SHOWN_SENTENCE ? `${s.slice(0, MAX_SHOWN_SENTENCE - 1)}…` : s);

  const hitHtml = (r, i, kind) => `<div class="hit" data-index="${i}">
      <button class="jump" type="button" title="Jump to this sentence on the page">
        <span class="rank">${i + 1}</span>${
          kind === "exact" ? `<span class="tag">exact</span>` : `<span class="score">${Math.round(r.score * 100)}%</span>`
        }<span class="sentence">${esc(clip(r.sentence))}</span>
      </button>
      <span class="why" hidden></span>
      <button class="copy" aria-label="Copy this quote" title="Copy this quote">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
    </div>`;

  /** Exact-word matches, found locally over the same passages — this pass never goes to
   *  the model (the meaning pass does; the literal one is plain string work).
   *  Capped at 4: this group is a glance, not a wall — meaning matches carry the list. */
  function literalMatches(query, blocks) {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const out = [];
    for (const b of blocks) {
      const idx = b.text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const { start, end } = sentenceWindow(b.text, idx, needle.length);
      out.push({ passageId: b.id, sentence: b.text.slice(start, end), offset: start, score: null, literal: true });
      if (out.length >= 4) break;
    }
    return out;
  }

  /** Expand a hit to sentence-ish boundaries (exact slice — offsets stay true). */
  function sentenceWindow(text, idx, len) {
    const isEnd = (c) => c === "." || c === "!" || c === "?" || c === "\n";
    let start = idx;
    while (start > 0 && !isEnd(text[start - 1])) start--;
    let end = idx + len;
    while (end < text.length && !isEnd(text[end])) end++;
    if (end < text.length && text[end] !== "\n") end++;
    while (start < idx && /\s/.test(text[start])) start++;
    while (end > idx + len && /\s/.test(text[end - 1])) end--;
    return { start, end };
  }

  function renderResults(query, literal, meaning, cross) {
    lastResults = [...literal, ...meaning];
    const crossHits = Array.isArray(cross?.results) ? cross.results : [];
    if (!lastResults.length && !crossHits.length) {
      showResults(
        `<div class="empty">No meaning matches for “${esc(query)}”.<div class="tip">Tracky only quotes sentences that already exist on this page — try rephrasing the question.</div></div>`,
      );
      return;
    }
    const parts = [];
    // Answer card: the top sentences, verbatim, with receipt chips. The server
    // never composes this — the client only re-shows what was found.
    const top = (meaning.length ? meaning : literal).slice(0, 2);
    if (top.length) {
      parts.push(
        `<div class="card">
        <div class="card-title">What this page says</div>
        ${top
          .map(
            (r, i) =>
              `<div class="card-line"><button class="chip" type="button" data-index="${lastResults.indexOf(r)}" title="See it in context" aria-label="Jump to match ${i + 1}">${i + 1}</button><span class="card-sentence">${esc(clip(r.sentence))}</span></div>`,
          )
          .join("")}
        <div class="card-foot">Quoted from this page — nothing invented. Tap a number to see it in context.</div>
      </div>`,
      );
    }
    if (literal.length) {
      parts.push(`<div class="group">Exact words · ${literal.length}</div>`);
      parts.push(literal.map((r, i) => hitHtml(r, i, "exact")).join(""));
    }
    if (meaning.length) {
      parts.push(`<div class="group">${literal.length ? "By meaning" : "Matches"} · ${meaning.length}</div>`);
      parts.push(meaning.map((r, i) => hitHtml(r, literal.length + i, "meaning")).join(""));
    }
    if (crossHits.length) parts.push(crossSection(crossHits, cross));
    parts.push(`<div class="results-foot"><button class="export" type="button">Copy all as markdown</button></div>`);
    showResults(parts.join(""));
  }

  /** Other tabs' hits, grouped by tab. Each quote is labelled with the tab it came
   *  from; clicking it brings that tab forward and runs the same question there. */
  function crossSection(hits, meta) {
    const byTab = new Map();
    for (const r of hits) {
      const key = r.tab?.tabId ?? -1;
      if (!byTab.has(key)) byTab.set(key, { tab: r.tab, rows: [] });
      byTab.get(key).rows.push(r);
    }
    const out = [`<div class="group">In your other tabs · ${hits.length}</div>`];
    for (const [, { tab, rows }] of byTab) {
      const title = tab?.title ?? "another tab";
      let host = "";
      try {
        host = new URL(tab?.url ?? "").hostname;
      } catch {
        host = "";
      }
      out.push(
        `<div class="xtab-head"><span class="t" title="${esc(title)}">${esc(clip(title))}</span><span class="u">${esc(host)}</span></div>`,
      );
      out.push(
        rows
          .map(
            (r, i) => `<div class="hit other" data-xindex="${hits.indexOf(r)}">
        <button class="jump" type="button" title="Open that tab and run this question there">
          <span class="rank">${i + 1}</span><span class="score">${Math.round((r.score ?? 0) * 100)}%</span><span class="sentence">${esc(clip(r.sentence))}</span>
        </button>
        <button class="copy" aria-label="Copy this quote" title="Copy this quote">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
        </button>
      </div>`,
          )
          .join(""),
      );
    }
    const skipped = meta?.skipped ?? {};
    const notes = [];
    if (skipped.blocked) notes.push(`${skipped.blocked} that cannot be scripted (PDFs, chrome:// pages)`);
    if (skipped.restricted) notes.push(`${skipped.restricted} denied or not permitted`);
    if (skipped.over) notes.push(`${skipped.over} beyond the 6-tab limit`);
    if (skipped.budget) notes.push(`${skipped.budget} with no room left in this search`);
    if (skipped.empty) notes.push(`${skipped.empty} with nothing readable`);
    if (skipped.current) notes.push(`${skipped.current} (this tab)`);
    if (skipped.hung) notes.push(`${skipped.hung} that stopped answering`);
    if (meta?.note) notes.push(meta.note);
    out.push(
      `<div class="card-foot" style="padding:8px 12px 2px">Quoted from your other tabs — nothing leaves them until you search.${
        notes.length ? ` Skipped: ${notes.join(", ")}.` : ""
      }</div>`,
    );
    return out.join("");
  }

  // ---- why-chips: one extra helper pass that only PICKS a reason from its fixed list ----
  function applyWhy(byId) {
    for (const el of resultsEl.querySelectorAll(".hit")) {
      const r = lastResults[Number(el.dataset.index)];
      const reason = r ? byId.get(r.passageId) : null;
      if (!reason) continue;
      r.why = reason; // kept on the result so the markdown export can include it
      const chip = el.querySelector(".why");
      if (chip) {
        chip.textContent = reason;
        chip.hidden = false;
      }
    }
  }

  async function loadWhy(query, matches, gen, cacheKey) {
    const withIds = matches.filter((m) => m.passageId).slice(0, 6); // chips cover the visible top of the list
    if (!withIds.length) return;
    try {
      const reply = await send(
        { type: "tracky:why", query, matches: withIds.map((m) => ({ passageId: m.passageId, sentence: m.sentence })) },
        35000,
      );
      if (gen !== whyGen) return; // a newer search owns the panel now — drop this reply
      if (!reply?.ok || !Array.isArray(reply.reasons)) return;
      const byId = new Map(reply.reasons.filter((r) => r && r.reason).map((r) => [r.passageId, r.reason]));
      if (!byId.size) return;
      const entry = cacheKey ? cache.get(cacheKey) : null;
      if (entry) entry.why = byId; // a cached re-run gets its chips back with zero calls
      applyWhy(byId);
    } catch {
      /* chips are auxiliary — the list stays useful without them */
    }
  }

  // ---- scope chips: page sections (headings) ----
  const scopeEl = $("#t-scope");
  function renderScope(sections, active) {
    // A section with any readable text is a legitimate scope; the cap keeps the
    // row a row (8 chips) and the "All" chip always offers the whole page.
    const usable = sections.filter((s) => s.count >= 1).slice(0, 8);
    if (usable.length < 2) {
      scopeEl.hidden = true;
      scopeEl.innerHTML = "";
      return;
    }
    scopeEl.hidden = false;
    scopeEl.innerHTML = [
      `<button class="scope-chip${active ? "" : " on"}" data-scope="">All <span class="n">${sections.reduce((a, s) => a + s.count, 0)}</span></button>`,
      ...usable.map(
        (s) =>
          `<button class="scope-chip${active === s.name ? " on" : ""}" data-scope="${esc(s.name)}" title="Search only this section: ${esc(s.name)}">${esc(s.name)} <span class="n">${s.count}</span></button>`,
      ),
    ].join("");
  }
  scopeEl.addEventListener("click", (e) => {
    const chip = e.target?.closest?.(".scope-chip");
    if (!chip) return;
    const next = chip.dataset.scope || null;
    if (next === scope) return;
    scope = next;
    if (input.value.trim()) runSearch();
    else renderScope(lastSections, scope);
  });

  // ---- export: all matches as markdown ----
  const IST = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  async function exportMarkdown(query) {
    const lines = [
      `# Tracky — “${query}”`,
      `Source: ${location.href}`,
      `When: ${IST.format(new Date())} IST`,
      `${lastPassages} passages · ${lastResults.length} matches${scope ? ` · section: “${scope}”` : ""}`,
      "",
      ...lastResults.map((r, i) => {
        const tag = r.literal ? "[exact]" : `[${Math.round(r.score * 100)}%]`;
        return `${i + 1}. ${tag} “${r.sentence}”${r.why ? ` — ${r.why}` : ""}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showStatusBriefly("ok", "copied all matches as markdown");
    } catch {
      showStatusBriefly("bad", "copy blocked by the page — select the text and copy it manually");
    }
  }

  // ---- receipts: highlight the exact quoted sentence on the page ----
  const HL_NAME = "tracky-hl";

  // ::highlight() rules must live in a page stylesheet — shadow styles can't reach
  // page ranges. One <style> in <head>, idempotent. Returns whether the rules
  // actually applied (a page CSP can block injected inline styles).
  function ensurePageStyle() {
    const existing = document.getElementById("tracky-page-style");
    const el = existing ?? document.createElement("style");
    if (!existing) {
      el.id = "tracky-page-style";
      el.textContent = `::highlight(${HL_NAME}) { background-color: rgba(245, 196, 83, .45); color: inherit; }`;
      (document.head ?? document.documentElement).appendChild(el);
    }
    return !!(el.sheet && el.sheet.cssRules && el.sheet.cssRules.length > 0);
  }

  function clearHighlight() {
    try {
      CSS.highlights?.delete(HL_NAME);
    } catch {
      /* no highlight support — nothing to clear */
    }
    for (const h of resultsEl.querySelectorAll(".hit")) h.classList.remove("selected");
  }

  const flashTimers = new WeakMap();
  function flash(el) {
    const prev = { outline: el.style.outline, offset: el.style.outlineOffset, radius: el.style.borderRadius };
    el.style.outline = "2px solid rgba(245, 196, 83, .55)";
    el.style.outlineOffset = "3px";
    el.style.borderRadius = "6px";
    clearTimeout(flashTimers.get(el));
    flashTimers.set(
      el,
      setTimeout(() => {
        el.style.outline = prev.outline;
        el.style.outlineOffset = prev.offset;
        el.style.borderRadius = prev.radius;
      }, 1500),
    );
  }

  /** Map a block-text offset back to a DOM Range via the collector's segment map. */
  function rangeFor(block, offset, length) {
    const segs = block.segments ?? [];
    // Gaps (synthetic <br>, skipped nodes) can't hold a boundary: snap the start
    // back to the previous real segment's end and the end forward to the next
    // segment's start, so the range can never collapse to zero length.
    const locate = (pos, isEnd) => {
      let prev = null;
      for (const s of segs) {
        if (s.synthetic) continue;
        const off = (p) => p - s.start + (s.base ?? 0); // node offset of a block-text position
        if (pos >= s.start && (pos < s.end || (isEnd && pos === s.end))) return { node: s.node, off: off(pos) };
        if (s.start > pos) return isEnd ? { node: s.node, off: s.base ?? 0 } : prev ? { node: prev.node, off: prev.end - prev.start + (prev.base ?? 0) } : { node: s.node, off: s.base ?? 0 };
        prev = s;
      }
      return prev ? { node: prev.node, off: prev.end - prev.start + (prev.base ?? 0) } : null;
    };
    const a = locate(offset, false);
    const b = locate(offset + length, true);
    if (!a || !b || !a.node.isConnected || !b.node.isConnected) return null;
    try {
      const r = new Range();
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off);
      return r;
    } catch {
      return null;
    }
  }

  /** Nearest ancestor that scrolls on its own (overflow + real overflow content). */
  function innerScroller(el) {
    // Stop before <html>: the root scroller is the window branch. <body> stays in
    // scope because it is a genuine container on some layouts.
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 8) return n;
    }
    return null;
  }

  function showStatusBriefly(kind, text, ms = 2600) {
    clearTimeout(statusTimer);
    setStatus(kind, text);
    statusTimer = setTimeout(() => setStatus(statsKind, statsLine), ms);
  }

  function jumpTo(index) {
    const r = lastResults[index];
    if (!r) return;
    const block = lastById?.get(r.passageId);
    if (!block || !block.element?.isConnected) {
      showStatusBriefly("bad", "that sentence is no longer on this page");
      return;
    }
    // The validator guarantees the sentence is an exact substring of the block text.
    const pos =
      Number.isFinite(r.offset) && block.text.slice(r.offset, r.offset + r.sentence.length) === r.sentence
        ? r.offset
        : block.text.indexOf(r.sentence);
    if (pos < 0) {
      showStatusBriefly("bad", "could not locate that sentence — the page may have changed");
      return;
    }
    const styled = ensurePageStyle(); // false when a page CSP blocks our injected rules
    let range = rangeFor(block, pos, r.sentence.length);
    if (range?.collapsed) range = null; // a zero-length mark would be a lie
    let highlightOk = false;
    if (range) {
      try {
        CSS.highlights.set(HL_NAME, new Highlight(range));
        highlightOk = true;
      } catch {
        /* older engine: scroll + flash only */
      }
    }
    const el = block.element;
    // Land the block instantly (works for window and inner scroll containers),
    // then ONE smooth correction centers the exact sentence. Two smooth scrolls
    // would cancel each other — found live on Wikipedia.
    el.scrollIntoView({ block: "center", behavior: "auto" });
    let marked = false;
    if (range) {
      const fresh = range.getBoundingClientRect(); // single layout read
      marked = highlightOk && styled && fresh.height > 0; // only a real, styled, visible mark counts
      if (marked) {
        const scroller = innerScroller(el);
        if (scroller) {
          const sr = scroller.getBoundingClientRect();
          const delta = fresh.top + fresh.height / 2 - (sr.top + sr.height / 2);
          if (Math.abs(delta) > 4) scroller.scrollBy({ top: delta, behavior: SCROLL() });
        } else {
          const delta = fresh.top + fresh.height / 2 - window.innerHeight / 2;
          if (Math.abs(delta) > 4) window.scrollBy({ top: delta, behavior: SCROLL() });
        }
      }
    }
    flash(el);
    for (const h of resultsEl.querySelectorAll(".hit")) h.classList.toggle("selected", Number(h.dataset.index) === index);
    showStatusBriefly("ok", marked ? "showing that sentence on the page" : "showing the paragraph — that sentence couldn't be marked");
  }

  async function copyQuote(index, xindex) {
    // A cross-tab row has no local passage to highlight, but its quote is real text —
    // copying works the same way (xindex selects from the other-tabs list).
    const r = xindex != null ? lastCross?.results?.[Number(xindex)] : lastResults[index];
    if (!r) return;
    try {
      await navigator.clipboard.writeText(r.sentence);
      showStatusBriefly("ok", "copied the quote");
    } catch {
      // clipboard blocked (rare): select-and-copy fallback
      const ta = document.createElement("textarea");
      ta.value = r.sentence;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      (document.body ?? document.documentElement).appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      showStatusBriefly(ok ? "ok" : "bad", ok ? "copied the quote" : "copy blocked by the page — select the sentence and copy it manually");
    }
  }

  /** Open another tab and run this same question in its own panel (Phase 14). */
  async function jumpToOtherTab(xindex) {
    const r = lastCross?.results?.[xindex];
    const tabId = r?.tab?.tabId;
    const q = input.value.trim();
    if (tabId == null) {
      showStatusBriefly("bad", "that tab is gone — run the search again");
      return;
    }
    showStatusBriefly("wait", "opening that tab…");
    // send() can time out or the service worker can be asleep: never let that
    // surface as an unhandled rejection — say what happened instead.
    let reply = null;
    try {
      reply = await send({ type: "tracky:jump", tabId, query: q }, 8000);
    } catch (err) {
      reply = { ok: false, error: String(err?.message ?? err) };
    }
    if (!reply?.ok) showStatusBriefly("bad", `could not open that tab — ${reply?.error ?? "unknown"}`);
  }

  resultsEl.addEventListener("click", (e) => {
    const chip = e.target?.closest?.(".chip"); // answer-card receipt chips
    if (chip) {
      jumpTo(Number(chip.dataset.index));
      return;
    }
    if (e.target?.closest?.(".export")) {
      exportMarkdown(input.value.trim());
      return;
    }
    if (e.target?.closest?.(".copy")) {
      const hit = e.target.closest(".hit");
      if (hit) copyQuote(Number(hit.dataset.index ?? -1), hit.dataset.xindex);
      return;
    }
    const jump = e.target?.closest?.(".jump");
    if (jump) {
      const hit = jump.closest(".hit");
      if (hit?.dataset.xindex != null) {
        jumpToOtherTab(Number(hit.dataset.xindex));
        return;
      }
      if (hit) jumpTo(Number(hit.dataset.index));
    }
  });
  resultsEl.addEventListener("keydown", (e) => {
    const jump = e.target?.closest?.(".jump");
    if (!jump) return;
    const jumps = [...resultsEl.querySelectorAll(".hit .jump")];
    const i = jumps.indexOf(jump);
    if (e.key === "ArrowDown") {
      jumps[Math.min(i + 1, jumps.length - 1)].focus();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      (i === 0 ? input : jumps[i - 1]).focus();
      e.preventDefault();
    }
  });

  let searching = false;
  let pendingSearch = false; // an Enter/scope-click during a search is queued, never dropped
  let pendingOpts = {};
  async function runSearch(o = {}) {
    const q = input.value.trim();
    if (!q) {
      if (!searching) ping(); // never clobber an in-flight search's status
      return;
    }
    if (isDenied()) {
      setStatus("idle", DENY_MSG);
      return;
    }
    if (searching) {
      pendingSearch = true;
      pendingOpts = o;
      return;
    }
    searching = true;
    const gen = ++whyGen; // any why-reply from an older search is now stale
    clearTimeout(statusTimer); // a stale revert must never overwrite search progress
    try {
      clearHighlight(); // a new question retires the old marker
      if (typeof window.__trackyCollect !== "function") {
        setStatus("bad", "page reader missing — reload the page and try again");
        return;
      }
      setStatus("wait", "reading the page…");
      let collected;
      try {
        collected = window.__trackyCollect();
      } catch {
        setStatus("bad", "could not read this page — try reloading it");
        showResults("");
        return;
      }
      if (!collected.blocks.length) {
        setStatus("bad", "no readable text found on this page");
        showResults("");
        return;
      }
      lastById = collected.byId ?? null;
      lastSections = Array.isArray(collected.sections) ? collected.sections : [];
      renderScope(lastSections, scope);
      const scoped = scope ? collected.blocks.filter((b) => lastById?.get(b.id)?.section === scope) : collected.blocks;
      if (!scoped.length) {
        setStatus("bad", `no readable text in “${scope}”`);
        showResults("");
        return;
      }
      lastPassages = scoped.length;
      // One key, two jobs: it keys the cache AND tells the dedupe whether the answer
      // on screen is still the answer to this question about this exact page state.
      const sig = `${collected.blocks.length}:${collected.stats?.chars ?? 0}:${collected.stats?.hash ?? 0}`;
      const key = `${location.href}::${scope ?? ""}::${q.toLowerCase()}::${sig}`;
      if (!o.force && key === lastSearchKey) {
        setStatus(statsKind, statsLine); // restore the answer we are already showing
        return; // same page, same question — nothing to redo
      }
      const hit = o.force ? null : cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL) {
        lastSearchKey = key;
        renderResults(q, hit.literalOnly, hit.meaning);
        const c = hit.meaning.length + hit.literalOnly.length;
        statsKind = c ? "ok" : "idle";
        statsLine = `${hit.passages} passages · ${c} match${c === 1 ? "" : "es"}${scope ? ` · “${scope}”` : ""} · cached`;
        setStatus(statsKind, statsLine);
        pushHistory(q);
        renderRecent();
        announce(`${c} match${c === 1 ? "" : "es"} for “${q}” (cached)`);
        if (hit.why) applyWhy(hit.why);
        else loadWhy(q, hit.meaning.length ? hit.meaning : hit.literalOnly, gen, key);
        if (o.jump) jumpTo(0);
        return;
      }
      setStatus("wait", `searching ${scoped.length} passages…`);
      const t0 = performance.now();
      // Cross-tab (Phase 14): the background gathers the other tabs' text and merges it
      // into this one request, so ranking happens across everything at once. The timeout
      // is longer because more passages means more batches.
      const wantCross = !!(xSearch && opts.crossTab);
      if (wantCross) setStatus("wait", `reading your other tabs…`);
      const reply = await send({ type: "tracky:search", query: q, passages: scoped, crossTab: wantCross }, wantCross ? 90000 : 45000);
      if (!reply?.ok) {
        const down = reply?.helperDown || /unreachable|not running|fetch/i.test(reply?.error ?? "");
        setStatus("bad", down ? HELP_FIX : `search failed — ${reply?.error ?? "unknown error"}`);
        showResults("");
        return;
      }
      const all = sanitizeResults(reply.results);
      const cross = all.filter((r) => r.tab);
      const meaning = all.filter((r) => !r.tab);
      lastCross = reply.crossTab?.enabled ? { ...reply.crossTab, results: cross } : null;
      // Hybrid: exact-word matches over the same passages, deduped against meaning.
      const seenSentences = new Set(meaning.map((r) => r.sentence));
      const literalOnly = literalMatches(q, scoped).filter((r) => !seenSentences.has(r.sentence));
      renderResults(q, literalOnly, meaning, lastCross);
      const ms = Math.round(Number.isFinite(reply.stats?.ms) ? reply.stats.ms : performance.now() - t0);
      const count = meaning.length + literalOnly.length;
      statsKind = count ? "ok" : "idle"; // neutral dot: zero matches is a finished answer, not progress
      const xtabNote = lastCross?.tabs ? ` · +${lastCross.tabs} tab${lastCross.tabs === 1 ? "" : "s"}${cross.length ? ` (${cross.length})` : ""}` : "";
      statsLine = `${scoped.length} passages · ${count} match${count === 1 ? "" : "es"}${scope ? ` · “${scope}”` : ""}${xtabNote} · ${ms} ms`;
      setStatus(statsKind, statsLine);
      lastSearchKey = key;
      pushHistory(q);
      renderRecent();
      cache.set(key, { meaning, literalOnly, passages: scoped.length, at: Date.now(), why: null });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // oldest out
      bumpSpend(scoped.length);
      announce(`${count} match${count === 1 ? "" : "es"} for “${q}”`);
      loadWhy(q, meaning.length ? meaning : literalOnly, gen, key); // fire-and-forget; chips never block the list
      if (o.jump) jumpTo(0);
    } catch (err) {
      setStatus("bad", /timeout/i.test(err?.message ?? "") ? "search timed out — is the helper healthy?" : HELP_FIX);
      showResults("");
    } finally {
      searching = false;
      if (pendingSearch) {
        pendingSearch = false; // the queued search runs once the current one is done
        const next = pendingOpts;
        pendingOpts = {};
        runSearch(next);
      }
    }
  }

  function pushHistory(q) {
    const i = history.indexOf(q);
    if (i >= 0) history.splice(i, 1);
    history.unshift(q);
    if (history.length > 8) history.pop();
  }

  const recentEl = $("#t-recent");
  function renderRecent() {
    const show = !input.value.trim() && history.length >= 1; // the last question stays one tap away
    recentEl.hidden = !show;
    if (!show) {
      recentEl.innerHTML = "";
      return;
    }
    recentEl.innerHTML = history
      .slice(0, 8)
      .map((q) => `<button class="recent-chip" type="button" data-q="${esc(q)}">${esc(q.length > 34 ? `${q.slice(0, 33)}…` : q)}</button>`)
      .join("");
  }
  recentEl.addEventListener("click", (e) => {
    const chip = e.target?.closest?.(".recent-chip");
    if (!chip) return;
    input.value = chip.dataset.q ?? "";
    renderRecent();
    runSearch();
  });

  function focusHit(i) {
    const jumps = resultsEl.querySelectorAll(".hit .jump");
    if (!jumps.length) return;
    jumps[Math.max(0, Math.min(i, jumps.length - 1))].focus();
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    renderRecent(); // the recent row belongs to an empty field
    const q = input.value.trim();
    if (q.length < 3) return; // one or two letters are noise, not a question
    debounceTimer = setTimeout(() => runSearch({ auto: true }), 700);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(debounceTimer); // the explicit gesture wins over the debounce
      runSearch(e.shiftKey ? { jump: true } : {}); // Shift+Enter = search and jump to the best match
      return;
    }
    if (e.key === "ArrowDown") {
      focusHit(0);
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowUp" && !input.value.trim() && history.length) {
      input.value = history[0]; // a quick way back to what you last asked
      renderRecent();
      e.preventDefault();
    }
  });

  // The rescan button: the page may have changed under us (SPA replaced its content).
  $("#t-rescan").addEventListener("click", () => {
    clearTimeout(debounceTimer);
    if (!input.value.trim() && history.length) input.value = history[0];
    renderRecent();
    runSearch({ force: true });
  });

  // Ctrl/Cmd+F opens Tracky instead of the browser's find bar (option, default on).
  document.addEventListener(
    "keydown",
    (e) => {
      if (!opts.hijackCtrlF) return;
      if (e.key !== "f" && e.key !== "F") return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (isDenied()) return;
      open();
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // SPA continuity: a URL change with the panel open re-runs the last question.
  // (An interval, not a MutationObserver — busy pages would fire a callback storm.)
  let lastHref = location.href;
  setInterval(() => {
    if (!visible || !lastSearchKey) return;
    if (location.href === lastHref) return;
    lastHref = location.href;
    clearTimeout(statusTimer);
    setStatus("wait", "page changed — re-scanning…");
    runSearch({ force: true });
  }, 1000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tracky:open") open();
    // Cross-tab jump (Phase 14): this tab was opened from another tab's results, so
    // run that question here without the user retyping it.
    if (msg?.type === "tracky:run" && typeof msg.query === "string" && msg.query.trim()) {
      open();
      input.value = msg.query;
      runSearch({ force: true });
    }
  });

  window.__tracky = { open, close, ping, version: VERSION };

  open(); // initial show goes through the same path (focus capture, ping, display)
})();
