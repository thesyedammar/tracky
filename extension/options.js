// Tracky — options page logic. Reads/writes chrome.storage.local only; the
// helper is contacted solely for a health check. No page text ever passes here.

const DEFAULTS = { hijackCtrlF: true, disabledHosts: [], countSearches: true };
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
    disabledHosts: hosts,
  };
  await chrome.storage.local.set({ trackyOpts: opts });
  flashSaved();
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
$("hosts").addEventListener("change", save);
$("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ trackySpend: null });
  renderSpend(null);
  flashSaved();
});

load();
pingHelper();
setInterval(pingHelper, 15000); // keep the status honest while the page is open
