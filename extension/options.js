// Tracky — options page logic. Reads/writes chrome.storage.local only; the
// helper is contacted solely for a health check. No page text ever passes here.

const DEFAULTS = { hijackCtrlF: true, disabledHosts: [], countSearches: true, crossTab: false, autoJump: true, source: null };
const HELPER = "http://127.0.0.1:4199";

const $ = (id) => document.getElementById(id);
const savedTag = $("saved");
let savedTimer = null;
let sourcesData = null; // the latest /api/providers payload, for the change listener

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
  $("autojump").checked = opts.autoJump !== false;
  $("hosts").value = Array.isArray(opts.disabledHosts) ? opts.disabledHosts.join("\n") : "";
  renderSpend(v.trackySpend);
  await loadSources(opts.source ?? null);
}

/** Populate the source dropdown from the helper's /api/providers (labels only,
 *  never keys). Offline → one honest option and a note that says to start it. */
async function loadSources(saved) {
  const sel = $("source");
  const note = $("source-note");
  let data = null;
  try {
    const res = await fetch(`${HELPER}/api/providers`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) data = await res.json();
  } catch {
    /* helper offline — handled below */
  }
  sel.textContent = "";
  const add = (value, label, disabled = false) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    o.disabled = disabled;
    sel.appendChild(o);
  };
  if (!data?.providers?.length) {
    sel.disabled = true;
    add("", "helper offline — start it to choose");
    note.textContent = "Start the helper (node server/server.mjs) and reopen this page to pick where Jev comes from.";
    note.className = "warn";
    return;
  }
  sel.disabled = false;
  const defP = data.providers.find((p) => p.id === data.default);
  const defOk = !defP || defP.configured; // a default with no key must not look pickable
  const firstOk = data.providers.find((p) => p.configured)?.id ?? "";
  const tagOf = (p) => [p.model, p.kind, p.badUrl ? "broken address" : p.configured ? "" : "no key yet"].filter(Boolean).join(" · ");
  // The default row is only disabled when something else can actually be picked.
  add("", `Helper default${defP ? ` — ${defP.label}${defOk ? "" : " · no key yet"}` : ""}`, !defOk && Boolean(firstOk));
  for (const p of data.providers) {
    add(p.id, `${p.label} · ${tagOf(p)}`, !p.configured);
  }
  const labelOf = (id) => data.providers.find((p) => p.id === id)?.label ?? id;
  const want = typeof saved === "string" ? saved.trim().toLowerCase() : "";
  const savedP = want ? data.providers.find((p) => p.id === want) : null;
  sel.value = savedP?.configured ? want : defOk ? "" : firstOk;
  if (want && sel.value !== want) {
    note.textContent = savedP
      ? `The source you picked earlier (“${savedP.label}”) can't be used right now — using ${sel.value ? `“${labelOf(sel.value)}”` : "the helper's default"} instead.`
      : `The source you picked earlier (“${want.slice(0, 40)}”) is not in JEV_PROVIDERS any more — using ${sel.value ? `“${labelOf(sel.value)}”` : "the helper's default"} instead.`;
    note.className = "warn";
    if (sel.value) await save();
  } else if (!defOk && !savedP?.configured) {
    // Only when the selection actually fell back: a valid explicit pick must not read as a switch.
    note.textContent = sel.value
      ? `The helper's default has no key — switched to “${labelOf(sel.value)}”.`
      : "No source has a key right now — add one to server/.env.";
    note.className = "warn";
    if (sel.value) await save();
  } else {
    updateSourceNote(data);
  }
  sourcesData = data; // the listener reads this, never a stale closure
  if (!loadSources.wired) {
    loadSources.wired = true; // a second call must not stack a second listener
    sel.addEventListener("change", async () => {
      updateSourceNote(sourcesData);
      await save();
    });
  }
}

function updateSourceNote(data) {
  const note = $("source-note");
  const id = $("source").value;
  const p = data?.providers?.find((x) => x.id === id);
  if (!p) {
    const defP = data?.providers?.find((x) => x.id === data.default);
    note.textContent = `Using the helper's default${defP ? ` — ${defP.label}` : ""}.`;
    note.className = "muted";
    return;
  }
  note.textContent =
    p.kind === "paid"
      ? `Using ${p.label} — searches are billed by the provider (pennies per search).`
      : `Using ${p.label} — nothing is billed; when its window is closed the helper tells you how long to wait.`;
  note.className = "muted";
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
  // A disabled select means the helper was offline while this page was open: its empty
  // value is "I couldn't ask", not "the user cleared it" — keep what was stored.
  const sel = $("source");
  const stored = (await chrome.storage.local.get({ trackyOpts: null }))?.trackyOpts?.source ?? null;
  const opts = {
    hijackCtrlF: $("hijack").checked,
    countSearches: $("count").checked,
    crossTab: $("cross").checked,
    autoJump: $("autojump").checked,
    disabledHosts: hosts,
    source: sel.disabled ? stored : sel.value || null,
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
