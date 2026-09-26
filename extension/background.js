// Tracky — background service worker.
//
// The only component that talks to the local helper. The page never reaches the
// helper directly, and the helper's key never leaves the server: the extension
// holds no credentials at all. Icon click (or Alt+K) injects the panel; the
// panel's messages are relayed here.

const HELPER = "http://127.0.0.1:4199";

/** Pages where scripting is impossible or pointless (file:// needs an opt-in Chrome never grants here). */
const UNSUPPORTED = /^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|file):/i;
const isUnsupported = (url) =>
  !url ||
  UNSUPPORTED.test(url) ||
  url.includes("chrome.google.com/webstore") ||
  url.includes("chromewebstore.google.com") ||
  /\.pdf(\?|#|$)/i.test(url);

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

async function openPanel(tab) {
  if (!tab || tab.id == null) return;
  if (isUnsupported(tab.url)) {
    await flash(tab.id, "×");
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "tracky:open" });
    await clearBadge(tab.id);
  } catch (err) {
    await flash(tab.id, "!");
  }
}

// No host_permissions on purpose: the helper's origin gate echoes
// chrome-extension:// origins, so a plain CORS fetch works — proven live by
// scripts/ext-smoke.py. Keeping the permission set at activeTab + scripting.

chrome.action.onClicked.addListener((tab) => {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tracky:health") {
    checkHealth().then(
      (health) => sendResponse({ ok: true, health }),
      (err) => sendResponse({ ok: false, error: err?.message ?? "unreachable" }),
    );
    return true; // async reply
  }
  return false;
});
