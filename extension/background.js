// Tracky — background service worker.
//
// The only component that talks to the local helper. The page never reaches the
// helper directly, and the helper's key never leaves the server: the extension
// holds no credentials at all. Icon click (or Alt+K) injects the panel; the
// panel's messages are relayed here.

const HELPER = "http://127.0.0.1:4199";
const DEFAULT_TITLE = "Tracky — search this page by meaning (Alt+K)";

importScripts("shared.js"); // hostMatches / hostDenied — one definition, unit-tested via the SW

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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collect.js", "content.js"] });
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

/** Ask the helper how it is doing. Times out fast so the panel stays honest. */
async function checkHealth() {
  const res = await fetch(`${HELPER}/api/health`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`helper replied ${res.status}`);
  const body = await res.json();
  if (body?.name !== "tracky-helper" || typeof body.version !== "string" || typeof body.model !== "string") {
    throw new Error("helper replied with an unexpected payload");
  }
  return { name: body.name, version: body.version, model: body.model, caps: body.caps };
}

/** Relay a search to the helper. The page text goes page → here → helper, nothing else. */
async function runSearch({ query, passages }) {
  let res;
  try {
    res = await fetch(`${HELPER}/api/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, passages }),
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
    e.helperDown = false; // any structured HTTP answer means the helper is running
    throw e;
  }
  return res.json(); // { results, stats }
}

/** Relay a why-chips pass to the helper. Same path as search: page text goes page → here → helper. */
async function runWhy({ query, matches }) {
  let res;
  try {
    res = await fetch(`${HELPER}/api/why`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, matches }),
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
const HELPER_PASSAGES_MAX = 1200; // the helper's ceiling, mirrored here

/** Collect blocks from the user's other http(s) tabs. Returns what it skipped, too. */
async function collectFromTabs(currentTabId, budget) {
  const skipped = { off: 0, denied: 0, restricted: 0, empty: 0, current: 0, over: 0 };
  const opts = (await chrome.storage.local.get({ trackyOpts: null }))?.trackyOpts ?? {};
  if (!opts.crossTab) return { on: false, tabs: [], skipped, skippedNote: "off" };
  if (budget <= 0) return { on: true, tabs: [], skipped, skippedNote: "no room" }; // nothing to do, read nothing

  let tabs = [];
  try {
    // Chrome only lists tabs this extension may touch: without a granted origin the
    // tab is invisible here, so it can never be read by accident.
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return { on: true, tabs: [], skipped, skippedNote: "no access" };
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
    if (candidates.length >= CROSS_MAX_TABS) {
      skipped.over++;
      continue;
    }
    if (isUnsupported(t.url) || isPdf(t.url) || denied(t.url)) {
      skipped.denied++;
      continue;
    }
    candidates.push(t);
  }
  if (!candidates.length) return { on: true, tabs: [], skipped, perTab: 0 };

  const perTab = Math.max(1, Math.min(CROSS_TOTAL, Math.floor(budget / candidates.length)));
  // One storage read, one injection pass, all tabs in parallel — no per-tab serial
  // round-trips, and a tab whose cap is 0 is simply never touched.
  const settled = await Promise.all(
    candidates.map(async (t) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["collect.js"] });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: (cap) => (typeof window.__trackyCollect === "function" ? window.__trackyCollect({ maxBlocks: cap }) : null),
          args: [perTab],
        });
        return { tab: t, blocks: res?.result?.blocks ?? [] };
      } catch {
        return { tab: t, blocks: null }; // no permission for that origin, or the tab is gone
      }
    }),
  );

  const picked = [];
  let total = 0;
  for (const { tab, blocks } of settled) {
    if (blocks === null) {
      skipped.restricted++;
      continue;
    }
    if (!blocks.length) {
      skipped.empty++;
      continue;
    }
    // Hard ceiling across all tabs — CROSS_TOTAL is a total, never a per-tab cap.
    const room = Math.min(perTab, CROSS_TOTAL - total, budget - total);
    if (room <= 0) {
      skipped.over++;
      continue;
    }
    const kept = blocks.slice(0, room);
    total += kept.length;
    picked.push({ tabId: tab.id, title: tab.title || tab.url, url: tab.url, blocks: kept });
  }
  return { on: true, tabs: picked, skipped, perTab };
}

/** One search over this tab plus the others. Local passage ids are untouched; other
 *  tabs' passages get a namespaced id (`<tabId>:<localId>`) so a merge can never
 *  collide with the local sequence, and every result maps back to its own tab. */
async function searchWithTabs({ query, passages, currentTabId }) {
  const local = Array.isArray(passages) ? passages : [];
  const budget = Math.max(0, HELPER_PASSAGES_MAX - local.length);
  const gathered = await collectFromTabs(currentTabId, budget);
  if (!gathered.on) return { ...(await runSearch({ query, passages: local })), crossTab: { enabled: false } };
  if (!gathered.tabs.length) {
    return { ...(await runSearch({ query, passages: local })), crossTab: { enabled: true, tabs: 0, passages: 0, skipped: gathered.skipped } };
  }

  const map = new Map();
  const merged = [...local];
  for (const t of gathered.tabs) {
    for (const b of t.blocks) {
      if (merged.length >= HELPER_PASSAGES_MAX) break;
      const id = `${t.tabId}:${b.id}`;
      if (map.has(id)) continue;
      map.set(id, { tabId: t.tabId, title: t.title, url: t.url });
      merged.push({ id, text: b.text });
    }
  }

  const out = await runSearch({ query, passages: merged });
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
      passages: map.size,
      skipped: gathered.skipped,
      titles: gathered.tabs.map((t) => t.title),
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["collect.js", "content.js"] });
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
      (err) => sendResponse({ ok: false, error: err?.message ?? "unreachable" }),
    );
    return true; // async reply
  }
  if (msg?.type === "tracky:search") {
    const tabId = _sender?.tab?.id;
    const run = msg.crossTab && tabId != null ? searchWithTabs({ query: msg.query, passages: msg.passages, currentTabId: tabId }) : runSearch(msg);
    run.then(
      (out) => sendResponse({ ok: true, ...out }),
      (err) => sendResponse({ ok: false, error: err?.message ?? "search failed", helperDown: !!err?.helperDown }),
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
      (err) => sendResponse({ ok: false, error: err?.message ?? "why failed", helperDown: !!err?.helperDown }),
    );
    return true; // async reply
  }
  return false;
});
