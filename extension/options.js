// Tracky — options page logic. Reads/writes chrome.storage.local only; the
// helper is contacted solely for a health check. No page text ever passes here.

const DEFAULTS = { hijackCtrlF: true, disabledHosts: [], countSearches: true, crossTab: false };
const HELPER = "http://127.0.0.1:4199";

const $ = (id) => document.getElementById(id);
const savedTag = $("saved");
let savedTimer = null;

function flashSaved() {
  savedTag.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedTag.classList.remove("on"), 1200);
}

async function load() {
  const v = await chrome.storage.local.get({ trackyOpts: null, trackySpend: null });
  const opts = { ...DEFAULTS, ...(v.trackyOpts ?? {}) };
  $("hijack").checked = opts.hijackCtrlF !== false;
  $("count").checked = opts.countSearches !== false;
  $("cross").checked = opts.crossTab === true;
  $("hosts").value = Array.isArray(opts.disabledHosts) ? opts.disabledHosts.join("\n") : "";
  renderSpend(v.trackySpend);
}

function renderSpend(spend) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const s = spend && spend.date === today ? spend : { searches: 0, passages: 0 };
  $("s-count").textContent = String(s.searches ?? 0);
  $("s-pass").textContent = String(s.passages ?? 0);
}

async function save() {
  const hosts = $("hosts")
    .value.split("\n")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && !h.includes(" ") && !h.startsWith("http"));
  const opts = {
    hijackCtrlF: $("hijack").checked,
    countSearches: $("count").checked,
    crossTab: $("cross").checked,
    disabledHosts: hosts,
  };
  await chrome.storage.local.set({ trackyOpts: opts });
  flashSaved();
}

/** Cross-tab needs permission for the other tabs' addresses, and Chrome only grants
 *  that from a click. Ask for exactly the origins of the tabs that are open right
 *  now — never a blanket "<all_urls>" — and say plainly what happens if it is refused. */
async function enableCrossTab() {
  const box = $("cross");
  const note = $("cross-note");
  if (!box.checked) {
    note.textContent = "Off — Tracky searches only the page you are on.";
    note.className = "muted";
    await save();
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const origins = [...new Set(tabs.map((t) => (t.url ? new URL(t.url).origin + "/*" : null)).filter(Boolean))];
    if (!origins.length) {
      note.textContent = "No web pages are open right now — this will work as soon as some are.";
      note.className = "muted";
      await save();
      return;
    }
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      box.checked = false;
      note.textContent = `Permission declined — Tracky can only search this page. (It asked for ${origins.length} open site(s), nothing more.)`;
      note.className = "warn";
      await save();
      return;
    }
    note.textContent = `On — ${origins.length} open site(s) allowed. Only the text of a tab you search is read, and only when you search.`;
    note.className = "ok";
    await save();
  } catch (e) {
    box.checked = false;
    note.textContent = `Could not enable: ${String(e?.message ?? e)}`;
    note.className = "warn";
    await save();
  }
}

async function pingHelper() {
  const dot = $("hdot");
  const text = $("htext");
  dot.className = "dot";
  text.textContent = "checking…";
  try {
    const res = await fetch(`${HELPER}/api/health`, { signal: AbortSignal.timeout(2500) });
    const body = await res.json();
    if (!res.ok || body?.name !== "tracky-helper") throw new Error("unexpected reply");
    dot.className = "dot ok";
    text.textContent = `helper ${body.version} · model ${body.model} · ready`;
  } catch {
    dot.className = "dot bad";
    text.textContent = "helper not running — start it: node server/server.mjs";
  }
}

$("hijack").addEventListener("change", save);
$("count").addEventListener("change", save);
$("cross").addEventListener("change", enableCrossTab);
$("hosts").addEventListener("change", save);
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ trackySpend: null });
  renderSpend(null);
  flashSaved();
});

load();
pingHelper();
setInterval(pingHelper, 15000); // keep the status honest while the page is open
