// Tracky — background service worker.
//
// The only component that talks to the helper — or, in direct mode, the only place
// that calls Jev from the browser (the key lives in chrome.storage.local and rides in
// the Authorization header of requests this worker makes; it is never logged). In
// helper mode the page never reaches the helper directly and the extension holds no
// credentials at all. Icon click (or Alt+K) injects the panel; the panel's messages
// are relayed here.

const HELPER = "http://127.0.0.1:4199";
const DEFAULT_TITLE = "Tracky — search this page by meaning (Alt+K)";

importScripts("shared.js", "direct.js"); // hostMatches / hostDenied + the direct-mode engine

/** Pages where scripting is impossible or pointless (file:// needs an opt-in Chrome never grants here). */
const UNSUPPORTED = /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|file):/i;
/** PDF detection cannot rely on the extension alone: plenty of papers live at
 *  /pdf/1234.5678 with no ".pdf" anywhere. These patterns cover the common shapes;
 *  anything they miss still gets caught by the second-click offer below. */
const isPdf = (url) =>
  !!url &&
  (/\.pdf(\?|#|$)/i.test(url) ||
    /\.pdf[/?#]/i.test(url) ||
    /\/pdf\/[^?#]+/i.test(url) ||
    /[?&](?:format|type|file|download)=pdf\b/i.test(url));
const isUnsupported = (url) =>
  !url ||
  UNSUPPORTED.test(url) ||
  url.includes("chrome.google.com/webstore") ||
  url.includes("chromewebstore.google.com");

/** Small visual reply on the toolbar icon; cleared on every successful open. */
const badgeState = new Map(); // tabId -> { timer, gen }
async function flash(tabId, text) {
  const st = badgeState.get(tabId) ?? { timer: null, gen: 0 };
  const gen = st.gen + 1;
  if (st.timer) clearTimeout(st.timer);
  badgeState.set(tabId, { timer: null, gen });
  const color = text === "!" ? "#B91C1C" : "#B45309";
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    return; // tab went away — nothing to say
  }
  if (badgeState.get(tabId)?.gen !== gen) return; // superseded while awaiting
  const timer = setTimeout(() => {
    if (badgeState.get(tabId)?.gen !== gen) return;
    badgeState.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }, 1800);
  badgeState.set(tabId, { timer, gen });
}

async function clearBadge(tabId) {
  const st = badgeState.get(tabId);
  if (st?.timer) clearTimeout(st.timer);
  badgeState.delete(tabId); // invalidates any in-flight flash awaiting its writes
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    /* tab went away */
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const st = badgeState.get(tabId);
  if (st?.timer) clearTimeout(st.timer);
  badgeState.delete(tabId);
  pdfOffer.delete(tabId); // a closed tab's offer dies with it: a future tab reusing
  // the id must never inherit "open the PDF reader" for a non-PDF page
});

/** The user's per-site deny list, straight from storage (options page writes it). */
async function disabledFor(url) {
  try {
    const v = await chrome.storage.local.get({ trackyOpts: null });
    const hosts = v?.trackyOpts?.disabledHosts;
    if (!Array.isArray(hosts) || !hosts.length) return false;
    return hostDenied(new URL(url).hostname, hosts); // same matcher as the panel (shared.js)
  } catch {
    return false; // storage trouble must never break opening the panel
  }
}

/** Open the PDF reader tab for a .pdf URL.
 *
 *  http(s) PDFs need permission for their own origin before an extension page may
 *  fetch them, so that request is made *first* in the click handler — still inside
 *  the user gesture, which is the only moment Chrome allows it. file:// PDFs work
 *  when "Allow access to file URLs" is on; the viewer says so plainly when it is not. */
async function openPdf(tab, granted) {
  const file = /^file:/i.test(tab.url);
  if (file) {
    let allowed = false;
    try {
      allowed = await chrome.extension.isAllowedFileSchemeAccess();
    } catch {
      /* API missing → assume not allowed and let the viewer explain */
    }
    if (!allowed) {
      try {
        await chrome.action.setTitle({
          tabId: tab.id,
          title: "Tracky needs 'Allow access to file URLs' (chrome://extensions → Tracky → Details) to read this PDF",
        });
      } catch {
        /* tab gone */
      }
      await flash(tab.id, "!");
      return;
    }
  }
  if (!file && !granted) {
    await flash(tab.id, "!");
  }
  const name = decodeURIComponent((tab.url.split("/").pop() || "document.pdf").split(/[?#]/)[0]);
  const url = chrome.runtime.getURL("pdf.html") + `?src=${encodeURIComponent(tab.url)}&name=${encodeURIComponent(name)}`;
  try {
    await chrome.tabs.create({ url, active: true });
    await chrome.action.setTitle({ tabId: tab.id, title: DEFAULT_TITLE });
    await clearBadge(tab.id);
  } catch {
    await flash(tab.id, "!");
  }
}

async function openPanel(tab) {
  if (!tab || tab.id == null) return;
  if (isUnsupported(tab.url)) {
    try {
      await chrome.action.setTitle({
        tabId: tab.id,
        title: "Tracky can't read this page — browser-internal pages and non-PDF file:// pages are off-limits",
      });
    } catch {
      /* tab gone */
    }
    await flash(tab.id, "×");
    return;
  }
  if (await disabledFor(tab.url)) {
    try {
      await chrome.action.setTitle({ tabId: tab.id, title: "Tracky is off for this site — see the options" });
    } catch {
      /* tab gone */
    }
    await flash(tab.id, "–");
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collect.js", "shared.js", "content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "tracky:open" });
    await chrome.action.setTitle({ tabId: tab.id, title: DEFAULT_TITLE });
    await clearBadge(tab.id);
  } catch (err) {
    // Scripting fails exactly where a page cannot be scripted — Chrome's own PDF
    // viewer being the common case (and the only one we can do something about).
    // Offer the reader on the first failure; the second click opens it.
    if (/^https?:/i.test(tab.url ?? "")) {
      pdfOffer.add(tab.id);
      try {
        await chrome.action.setTitle({
          tabId: tab.id,
          title: "Tracky can't read this tab — if it is a PDF, click the icon again to open it in Tracky's reader",
        });
      } catch {
        /* tab gone */
      }
      await flash(tab.id, "↗");
      return;
    }
    await flash(tab.id, "!");
  }
}

// No host_permissions on purpose: the helper's origin gate echoes
// chrome-extension:// origins, so a plain CORS fetch works — proven live by
// scripts/ext-smoke.py. Keeping the permission set at activeTab + scripting + storage.

/** Tabs where scripting failed once and we offered the PDF reader (second click opens it). */
const pdfOffer = new Set();

chrome.action.onClicked.addListener((tab) => {
  // A PDF tab goes to the reader — and the origin permission is requested here,
  // synchronously, while the click's user gesture is still live. The same path
  // serves the second click on a tab where scripting failed (an extensionless PDF).
  const wantsReader = !!tab?.url && (isPdf(tab.url) || pdfOffer.has(tab.id));
  if (wantsReader) {
    pdfOffer.delete(tab.id);
    if (/^https?:/i.test(tab.url)) {
      let origin = null;
      try {
        origin = new URL(tab.url).origin + "/*";
      } catch {
        origin = null;
      }
      if (origin) {
        chrome.permissions
          .request({ origins: [origin] })
          .then((granted) => openPdf(tab, granted))
          .catch(() => openPdf(tab, false));
        return;
      }
    }
    openPdf(tab, true);
    return;
  }
  openPanel(tab);
});

/** Ask the helper how it is doing. Times out fast so the panel stays honest.
 *  In direct mode there is no helper to ask: report the mode, the route and whether
 *  a key is saved, so the panel can say "direct · jev-1.13 · ready" or tell the user
 *  to paste one. */
async function checkHealth() {
  const opts = await readOpts();
  if (opts.mode === "direct") {
    const cfg = TrackyDirect.configFrom({ key: opts.directKey, sourceId: opts.directSource });
    let permit = false;
    try {
      permit = await chrome.permissions.contains({ origins: [cfg.origin] });
    } catch {
      /* no answer → not permitted, and the panel says which of the two is missing */
    }
    return {
      name: "tracky-direct",
      version: chrome.runtime.getManifest().version,
      model: cfg.model,
      direct: true,
      key: Boolean(cfg.apiKey), // a key is saved
      permit, // and the origin is allowed
      ready: Boolean(cfg.apiKey) && permit,
    };
  }
  const res = await fetch(`${HELPER}/api/health`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`helper replied ${res.status}`);
  const body = await res.json();
  if (body?.name !== "tracky-helper" || typeof body.version !== "string" || typeof body.model !== "string") {
    throw new Error("helper replied with an unexpected payload");
  }
  return { name: body.name, version: body.version, model: body.model, caps: body.caps };
}

/** The Jev source picked in options, or null for the helper's default. Only the
 *  id travels — the keys stay in the helper's .env, as always. */
async function chosenSource() {
  const v = await chrome.storage.local.get({ trackyOpts: null });
  const s = v?.trackyOpts?.source;
  return typeof s === "string" && s ? s : null;
}

/** The whole options object (mode, key, source, deny list…). Never throws: storage
 *  trouble must not break a search. */
async function readOpts() {
  try {
    return (await chrome.storage.local.get({ trackyOpts: null }))?.trackyOpts ?? {};
  } catch {
    return {};
  }
}

/** One wording for "the origin permission is missing", used by both the pre-flight
 *  check and the mid-search explanation below — two phrasings for one condition is
 *  how users end up unsure whether they are seeing the same problem. */
const permissionMessage = (cfg) =>
  `Direct mode needs permission for ${cfg.origin.replace(/^[a-z]+:\/\//i, "").replace(/\/\*$/, "")} — open Tracky's options and pick Direct again.`;

/** Direct mode: OUR port of the engine (direct.js) plus the key the user pasted.
 *  Two things can stop it before any request — no key, and no host permission —
 *  and both say exactly which one it is (a direct search never reports anything
 *  as "unreachable": there is no helper involved to be down). */
async function directConfig(opts) {
  const cfg = TrackyDirect.configFrom({ key: opts.directKey, sourceId: opts.directSource });
  // Every direct failure carries a status so the panel and the suites can act on it
  // instead of parsing prose: 400 no key, 403 no permission (both pre-flight).
  if (!cfg.apiKey) throw Object.assign(new Error(TrackyDirect.NO_KEY), { status: 400 });
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [cfg.origin] });
  } catch {
    /* no answer from the permissions API → treat it as not granted and say so */
  }
  if (!granted) throw Object.assign(new Error(permissionMessage(cfg)), { status: 403 });
  return cfg;
}

/** A failed direct search has two honest explanations — the connection (or a slow route),
 *  or a host permission revoked after the mode was switched on. Every network-shaped
 *  failure is a 502; for those, ask Chrome which story is true instead of blaming the
 *  user's internet. Anything else (no key, bad key, quota) already says what it is. */
async function explainDirectFailure(e, opts) {
  if (e?.status !== 502) return e;
  try {
    const cfg = TrackyDirect.configFrom({ key: opts.directKey, sourceId: opts.directSource });
    const granted = await chrome.permissions.contains({ origins: [cfg.origin] });
    if (!granted) return Object.assign(new Error(permissionMessage(cfg)), { status: 403 });
  } catch {
    /* no useful answer — keep the original message */
  }
  return e;
}

/** Run a search. Helper mode relays it to 127.0.0.1:4199; direct mode runs our own
 *  port (direct.js) in this worker. Either way the panel gets the same shape back. */
/** Tell the tab how far a search has come. Fire and forget: a closed tab, a
 *  reloaded page or a dead port must never turn progress into an error. */
function notifyProgress(tabId, p) {
  if (!Number.isFinite(tabId) || !p) return;
  try {
    chrome.tabs.sendMessage(tabId, { type: "tracky:progress", ...p }).catch(() => {});
  } catch {
    /* no tab to talk to */
  }
}

/**
 * The helper's SSE progress channel (POST /api/search?stream=1): `progress` events
 * while it sweeps, one `result` event at the end, `error` events for failures.
 * Returns null when streaming is not available so the caller can use the plain call.
 * A stream that dies AFTER reporting progress throws — retrying it the plain way
 * would spend the model twice for one question.
 */
async function helperSearchStream(body, onProgress) {
  let res;
  try {
    res = await fetch(`${HELPER}/api/search?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000),
    });
  } catch {
    return null; // unreachable: the plain path reports it properly
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !ctype.includes("text/event-stream")) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result = null;
  let sawProgress = false;
  // One parser for every frame, streaming or tail: split on raw-byte boundaries
  // (findSseBoundary never normalizes, so a CR/LF split across two reads cannot
  // fuse into a phantom frame) and parse each frame the same way.
  const handleFrame = (frame) => {
    const parsed = parseSseFrame(frame);
    if (!parsed) return; // heartbeat, comment or trailing whitespace: never fatal
    let payload;
    try {
      payload = JSON.parse(parsed.data);
    } catch {
      return; // a frame we cannot read is not a reason to lose the answer
    }
    if (parsed.ev === "progress") {
      sawProgress = true;
      onProgress?.(payload);
    } else if (parsed.ev === "result") {
      result = payload;
    } else if (parsed.ev === "error") {
      const e = new Error(payload?.message ?? "search failed");
      e.status = payload?.status ?? null;
      e.helperDown = false; // a structured answer means the helper IS running
      throw e;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = findSseBoundary(buf)) !== null) {
      handleFrame(buf.slice(0, cut.index));
      buf = buf.slice(cut.index + cut.length);
    }
  }
  buf += decoder.decode();
  if (buf) handleFrame(buf); // a tail frame without a trailing blank line still counts
  if (result) return result;
  if (sawProgress) throw new Error("the helper's stream ended early — try again");
  return null; // nothing was spent yet: the plain call is safe
}

async function runSearch({ query, passages }, tabId) {
  const opts = await readOpts();
  if (opts.mode === "direct") {
    // A direct failure is our failure: throw it without the helperDown flag, so the
    // panel shows the message instead of "start your helper".
    try {
      return await TrackyDirect.searchText(
        { query, passages },
        { config: await directConfig(opts), onProgress: (p) => notifyProgress(tabId, p) },
      );
    } catch (e) {
      throw await explainDirectFailure(e, opts);
    }
  }
  const source = await chosenSource();
  // Streaming first: the same call, but the passes come back as they land.
  const streamed = await helperSearchStream(
    { query, passages, ...(source ? { provider: source } : {}) },
    (p) => notifyProgress(tabId, p),
  );
  if (streamed) return streamed;
  let res;
  try {
    res = await fetch(`${HELPER}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, passages, ...(source ? { provider: source } : {}) }),
      signal: AbortSignal.timeout(35000), // big pages: 8 serial passes ≈ 6–8 s
    });
  } catch {
    const e = new Error("helper unreachable");
    e.helperDown = true;
    throw e;
  }
  if (!res.ok) {
    let message = `helper replied ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* not JSON — keep the status line */
    }
    const e = new Error(message);
    e.status = res.status; // 429 = a quota window: BLOCKED, never a product failure
    e.helperDown = false; // any structured HTTP answer means the helper is running
    throw e;
  }
  return res.json(); // { results, stats }
}

/** Relay a why-chips pass to the helper — or run it in direct mode. Same path as
 *  search: the panel's sentences go page → here → (helper | Jev), nothing else. */
async function runWhy({ query, matches }) {
  const opts = await readOpts();
  if (opts.mode === "direct") {
    try {
      return await TrackyDirect.whyFor({ query, matches }, { config: await directConfig(opts) });
    } catch (e) {
      throw await explainDirectFailure(e, opts);
    }
  }
  const source = await chosenSource();
  let res;
  try {
    res = await fetch(`${HELPER}/api/why`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, matches, ...(source ? { provider: source } : {}) }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    const e = new Error("helper unreachable");
    e.helperDown = true;
    throw e;
  }
  if (!res.ok) {
    let message = `helper replied ${res.status}`;
    try {
      message = (await res.json()).message ?? message;
    } catch {
      /* not JSON — keep the status line */
    }
    const e = new Error(message);
    e.status = res.status; // a quota window stays a quota window on this path too
    e.helperDown = false;
    throw e;
  }
  return res.json(); // { reasons, stats }
}

// ---------------------------------------------------------------- Phase 14: cross-tab
//
// Searching your other open tabs is opt-in (options page), bounded (never more than
// the helper's 1,200-passage ceiling in total), and honest about what it skipped.
// Only collect.js is injected into other tabs — no panel, no UI, nothing runs there
// until you ask. Tabs you have denied are never touched, and Chrome's own
// restrictions (chrome://, the web store, PDFs) are counted, not guessed at.

const CROSS_MAX_TABS = 6;
const CROSS_TOTAL = 600; // our own cap on how much other tabs may add
const CROSS_CHARS = 400_000; // and on how many characters they may add (payload ceiling)
const HELPER_PASSAGES_MAX = 1200; // the helper's ceiling, mirrored here

/** Collect blocks from the user's other http(s) tabs. Returns what it skipped, too. */
async function collectFromTabs(currentTabId, budget) {
  // Normalised shape on every return: callers never have to guess which fields exist.
  const skipped = { blocked: 0, denied: 0, restricted: 0, noCollector: 0, empty: 0, current: 0, over: 0, budget: 0, hung: 0 };
  const done = (patch) => ({ on: true, tabs: [], perTab: 0, skippedNote: "", skipped, ...patch });
  budget = Number.isFinite(budget) ? Math.floor(budget) : 0; // a bad budget reads nothing, never NaN
  if (budget <= 0) return done({ skippedNote: "no room" }); // nothing to read, nothing to ask
  let opts = {};
  try {
    opts = (await chrome.storage.local.get({ trackyOpts: null }))?.trackyOpts ?? {};
  } catch {
    return done({ skippedNote: "storage unavailable" }); // fail safe: read nothing
  }
  if (!opts.crossTab) return done({ on: false, skippedNote: "off" });

  let tabs = [];
  try {
    // Chrome only lists tabs this extension may touch: without a granted origin the
    // tab is invisible here, so it can never be read by accident.
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return done({ skippedNote: "no access" });
  }

  // Pick the candidates first (cheap, no injection), so the per-tab cap can be
  // computed from the real number of tabs and the total can never exceed budget.
  const denied = (url) => {
    try {
      return hostDenied(new URL(url).hostname, opts.disabledHosts ?? []); // same matcher as the panel
    } catch {
      return false;
    }
  };
  const candidates = [];
  for (const t of tabs) {
    if (t.id == null) continue;
    if (t.id === currentTabId) {
      skipped.current++;
      continue;
    }
    // Everything we would never touch is counted first, so the 6-tab cut only ever
    // hides tabs we could actually have read.
    if (isUnsupported(t.url) || isPdf(t.url)) {
      skipped.blocked++; // chrome://, the web store, PDFs — never scriptable
      continue;
    }
    if (denied(t.url)) {
      skipped.denied++; // the user put this host on the deny list
      continue;
    }
    if (candidates.length >= CROSS_MAX_TABS) {
      skipped.over++;
      continue;
    }
    candidates.push(t);
  }
  if (!candidates.length) return done({});

  const perTab = Math.max(1, Math.min(CROSS_TOTAL, Math.floor(budget / candidates.length)));
  // The passage cap above is per tab, but the collector's char cap defaults to
  // the whole 400k per tab — 6 tabs could inject 2.4M chars before the merge's
  // room check ever sees them. Split the ceiling the same way so each tab is
  // asked for at most its share.
  const perTabChars = Math.max(1, Math.floor(CROSS_CHARS / candidates.length));
  // One storage read, one injection pass, all tabs in parallel — no per-tab serial
  // round-trips. A tab that never answers (a hung renderer) must not hang the whole
  // search: each collection races a 4s deadline, the timer is cleared either way, and
  // the tab's identity is kept so the skip is reported against the right tab.
  const deadline = (tab, p, ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ tab, blocks: null, hung: true }), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        () => {
          clearTimeout(t);
          resolve({ tab, blocks: null });
        },
      );
    });
  const settled = await Promise.all(
    candidates.map((t) =>
      deadline(
        t,
        (async () => {
          try {
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["collect.js"] });
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: t.id },
              func: (cap, capChars) => (typeof window.__trackyCollect === "function" ? window.__trackyCollect({ maxBlocks: cap, maxChars: capChars }) : null),
              args: [perTab, perTabChars],
            });
            const blocks = Array.isArray(res?.result?.blocks) ? res.result.blocks : null;
            return { tab: t, blocks };
          } catch {
            return { tab: t, blocks: null }; // no permission for that origin, or the tab is gone
          }
        })(),
        4000,
      ),
    ),
  );

  const picked = [];
  let total = 0;
  for (const { tab, blocks, hung } of settled) {
    if (!tab || blocks === null) {
      if (hung) skipped.hung++;
      else if (!tab) skipped.restricted++; // the tab is gone or not permitted
      else skipped.noCollector++; // the page never offered a collector (a mismatch, not a refusal)
      continue;
    }
    if (!blocks.length) {
      skipped.empty++;
      continue;
    }
    // Hard ceiling across all tabs — CROSS_TOTAL is a total, never a per-tab cap.
    const room = Math.min(perTab, CROSS_TOTAL - total, budget - total);
    if (room <= 0) {
      skipped.budget++;
      continue;
    }
    const kept = blocks.slice(0, room);
    total += kept.length;
    picked.push({ tabId: tab.id, title: tab.title || tab.url, url: tab.url, blocks: kept });
  }
  return { on: true, tabs: picked, skipped, perTab, skippedNote: "" };
}

/** One search over this tab plus the others. Local passage ids are untouched; other
 *  tabs' passages get a namespaced id (`<tabId>:<localId>`) so a merge can never
 *  collide with the local sequence, and every result maps back to its own tab. */
async function searchWithTabs({ query, passages, currentTabId }) {
  const local = Array.isArray(passages) ? passages : [];
  const budget = Math.max(0, HELPER_PASSAGES_MAX - local.length);
  const gathered = await collectFromTabs(currentTabId, budget);
  if (!gathered.on) return { ...(await runSearch({ query, passages: local }, currentTabId)), crossTab: { enabled: false } };
  if (!gathered.tabs.length) {
    return {
      ...(await runSearch({ query, passages: local }, currentTabId)),
      crossTab: { enabled: true, tabs: 0, passages: 0, skipped: gathered.skipped, note: gathered.skippedNote },
    };
  }

  const map = new Map();
  const merged = [...local];
  // The helper's frozen contract requires ids shaped like p0, p1, … so cross-tab
  // passages continue the sequence *after* the highest local id. Deriving it from the
  // real ids (not from the array length) keeps it collision-free even when the local
  // set is sparse, which a scoped search makes it. (Local ids are always pN — the
  // helper rejects anything else, so there is no other shape to handle.)
  let nextId = 0;
  for (const p of local) {
    const m = /^p(\d+)$/.exec(typeof p?.id === "string" ? p.id : "");
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
  }
  // Payload ceiling as well as a passage ceiling: one enormous page must not push the
  // request past what the helper accepts, so the text budget is enforced as we merge.
  // Each passage also carries an id and JSON punctuation, so the cost is text + 40.
  const cost = (t) => t.length + 40;
  let chars = 0;
  for (const p of local) if (typeof p?.text === "string") chars += cost(p.text);
  let done = false;
  for (const t of gathered.tabs) {
    if (done) break;
    for (const b of t.blocks) {
      // Both ceilings stop the merge the same way, and both are counted: the search
      // must be able to say how much was left out and why.
      if (merged.length >= HELPER_PASSAGES_MAX || chars >= CROSS_CHARS) {
        gathered.skipped.budget++;
        done = true;
        break;
      }
      // Only well-formed passages cross the boundary: an id and non-empty text.
      if (typeof b?.id !== "string" || typeof b.text !== "string" || !b.text.length) continue;
      if (chars + cost(b.text) > CROSS_CHARS) {
        gathered.skipped.budget++;
        done = true;
        break;
      }
      const id = `p${nextId++}`;
      map.set(id, { tabId: t.tabId, title: t.title, url: t.url });
      merged.push({ id, text: b.text });
      chars += cost(b.text);
    }
  }

  const out = await runSearch({ query, passages: merged }, currentTabId);
  const results = (out.results ?? []).map((r) => {
    const tab = map.get(r.passageId);
    return tab ? { ...r, tab } : r;
  });
  return {
    ...out,
    results,
    crossTab: {
      enabled: true,
      tabs: gathered.tabs.length,
      // Only the tabs that actually contributed passages: a tab whose blocks were all
      // dropped by a ceiling must not be listed as if it were searched.
      titles: [...new Set([...map.values()].map((m) => m.title))],
      passages: map.size,
      skipped: gathered.skipped,
    },
  };
}

/** Bring another tab to the front and run the same question in its own panel. */
async function jumpToTab({ tabId, query }) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* window focus is a nicety, never a failure */
      }
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["collect.js", "shared.js", "content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "tracky:run", query });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tracky:health") {
    checkHealth().then(
      (health) => sendResponse({ ok: true, health }),
      (err) => sendResponse({ ok: false, error: err?.message ?? "unreachable", status: err?.status ?? null }),
    );
    return true; // async reply
  }
  if (msg?.type === "tracky:search") {
    const tabId = _sender?.tab?.id;
    const run =
      msg.crossTab && tabId != null
        ? searchWithTabs({ query: msg.query, passages: msg.passages, currentTabId: tabId })
        : runSearch(msg, tabId);
    run.then(
      (out) => sendResponse({ ok: true, ...out }),
      (err) => sendResponse({ ok: false, error: err?.message ?? "search failed", status: err?.status ?? null, helperDown: !!err?.helperDown }),
    );
    return true; // async reply
  }
  if (msg?.type === "tracky:jump") {
    jumpToTab({ tabId: msg.tabId, query: msg.query }).then((out) => sendResponse(out));
    return true; // async reply
  }
  if (msg?.type === "tracky:why") {
    runWhy(msg).then(
      (out) => sendResponse({ ok: true, ...out }),
      (err) => sendResponse({ ok: false, error: err?.message ?? "why failed", status: err?.status ?? null, helperDown: !!err?.helperDown }),
    );
    return true; // async reply
  }
  return false;
});
