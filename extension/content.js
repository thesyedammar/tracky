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
      @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
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
      .box { padding: 0 12px 12px; }
      input[type="text"] {
        width: 100%; box-sizing: border-box; background: rgba(255, 255, 255, .05);
        border: 1px solid rgba(255, 255, 255, .10); border-radius: 10px;
        color: #E9EDF5; padding: 9px 11px; font: inherit;
      }
      input::placeholder { color: #7C8698; }
      .status {
        display: flex; align-items: center; gap: 8px; padding: 9px 12px 11px;
        border-top: 1px solid rgba(255, 255, 255, .06); color: #AAB3C2; font-size: 12px;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8A94A6; flex: none; }
      .dot.ok { background: #3ECF8E; box-shadow: 0 0 0 3px rgba(62, 207, 142, .15); }
      .dot.bad { background: #F26D6D; box-shadow: 0 0 0 3px rgba(242, 109, 109, .15); }
      .dot.idle { background: #8A94A6; }
      .dot.wait { background: #F5C453; animation: tPulse 1.1s ease-in-out infinite; }
      @keyframes tPulse { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) { .dot.wait { animation: none; } }
      .hint { color: #7C8698; font-size: 11px; padding: 0 12px 11px; }
      kbd { background: rgba(255, 255, 255, .08); border-radius: 4px; padding: 1px 5px; font: 10px ui-monospace, monospace; }
      .results { display: none; max-height: 320px; overflow: auto; padding: 2px 12px 10px; }
      .results.open { display: block; }
      .hit {
        padding: 8px 10px; border-radius: 10px; margin-bottom: 7px;
        background: rgba(255, 255, 255, .04); border: 1px solid rgba(255, 255, 255, .06);
      }
      .hit:last-child { margin-bottom: 2px; }
      .hit .score { display: inline-block; min-width: 36px; margin-right: 7px; color: #F5C453; font-weight: 650; font-variant-numeric: tabular-nums; }
      .hit .sentence { color: #DEE5EF; }
      .empty { color: #8A94A6; padding: 8px 2px 4px; }
      .results::-webkit-scrollbar { width: 8px; }
      .results::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .14); border-radius: 8px; }
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
        </div>
        <div class="results" id="t-results" aria-live="polite"></div>
        <div class="status" aria-live="polite">
          <span class="dot wait" id="t-dot"></span><span id="t-status">checking the helper…</span>
        </div>
        <div class="hint">Finds ideas, not just letters — then quotes the exact sentences. <kbd>Enter</kbd> search · <kbd>Esc</kbd> close.</div>
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
  };

  const send = (msg, ms = 3000) => {
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
    if (prev instanceof HTMLElement && prev !== input) lastFocus = prev; // first open included
    const wasVisible = visible;
    wrap.style.display = "";
    visible = true;
    if (!wasVisible) ping(); // idempotent: a re-inject + tracky:open pair pings once
    input.focus({ preventScroll: true });
  }
  function close() {
    wrap.style.display = "none";
    visible = false;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  $(".close").addEventListener("click", close);

  document.addEventListener(
    "keydown",
    (e) => {
      // Only when the panel itself has focus (document.activeElement retargets to
      // the host while focus is inside the shadow root) — never hijack page dialogs.
      if (e.key !== "Escape" || !visible || document.activeElement !== host) return;
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
        score: Number(r?.score),
        offset: Number(r?.offset),
      }))
      .filter((r) => r.sentence.length > 0 && Number.isFinite(r.score));

  function renderResults(query, results) {
    if (!results.length) {
      showResults(`<div class="empty">No meaning matches for “${esc(query)}”.</div>`);
      return;
    }
    showResults(
      results
        .map(
          (r) => `<div class="hit" data-passage="${esc(r.passageId)}" data-offset="${Number.isFinite(r.offset) ? r.offset : 0}">
            <span class="score">${Math.round(r.score * 100)}%</span><span class="sentence">${esc(r.sentence)}</span>
          </div>`,
        )
        .join(""),
    );
  }

  let searching = false;
  async function runSearch() {
    const q = input.value.trim();
    if (!q) {
      ping();
      return;
    }
    if (searching) return;
    searching = true;
    try {
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
      setStatus("wait", `searching ${collected.blocks.length} passages…`);
      const t0 = performance.now();
      const reply = await send({ type: "tracky:search", query: q, passages: collected.blocks }, 45000);
      if (!reply?.ok) {
        const down = reply?.helperDown || /unreachable|not running|fetch/i.test(reply?.error ?? "");
        setStatus("bad", down ? HELP_FIX : `search failed — ${reply?.error ?? "unknown error"}`);
        showResults("");
        return;
      }
      const results = sanitizeResults(reply.results);
      renderResults(q, results);
      const ms = Math.round(Number.isFinite(reply.stats?.ms) ? reply.stats.ms : performance.now() - t0);
      const count = results.length;
      setStatus(
        count ? "ok" : "idle", // neutral dot: zero matches is a finished answer, not progress
        `${collected.blocks.length} passages · ${count} match${count === 1 ? "" : "es"} · ${ms} ms`,
      );
    } catch (err) {
      setStatus("bad", /timeout/i.test(err?.message ?? "") ? "search timed out — is the helper healthy?" : HELP_FIX);
      showResults("");
    } finally {
      searching = false;
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    runSearch();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tracky:open") open();
  });

  window.__tracky = { open, close, ping, version: VERSION };

  open(); // initial show goes through the same path (focus capture, ping, display)
})();
