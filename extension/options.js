// Tracky — options page logic. Reads/writes chrome.storage.local only; the
// helper is contacted solely for a health check (never in direct mode, where the
// extension talks to Jev itself with the key the user pasted here).

const DEFAULTS = {
  hijackCtrlF: true,
  disabledHosts: [],
  countSearches: true,
  crossTab: false,
  autoJump: true,
  source: null,
  mode: "helper", // "helper" (default) | "direct"
  directKey: "",
  directSource: "",
};
const HELPER = "http://127.0.0.1:4199";
/** direct.js loads before this file (options.html). If it ever fails to load, the page
 *  must still open — it is the only place a broken install can be fixed — so every use
 *  is guarded and says what is wrong instead of throwing on the first line. */
const DIRECT = globalThis.TrackyDirect ?? null;
const DIRECT_ORIGINS = DIRECT ? [...new Set(DIRECT.ROUTES.map((r) => r.origin))] : [];
/** shared.js loads before this file (options.html): pure hostname normalization.
 *  Guarded like DIRECT above — the page must still open if it ever fails to load. */
const SHARED = globalThis.TrackyShared ?? null;

const $ = (id) => document.getElementById(id);
/** Say something where the user can see it. #dtest-note lives inside the Direct panel,
 *  which is hidden the moment the mode reverts to helper — this line is always visible. */
function setNote(kind, text) {
  const el = $("mode-note");
  el.hidden = false;
  el.className = kind === "warn" ? "warn" : "muted";
  el.textContent = text;
}
const savedTag = $("saved");
let savedTimer = null;
let sourcesData = null; // the latest /api/providers payload, for the change listener

const isDirect = () => $("mode-direct").checked;

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
  const wantsDirect = opts.mode === "direct";
  $("mode-direct").checked = wantsDirect && Boolean(DIRECT);
  $("mode-helper").checked = !(wantsDirect && Boolean(DIRECT));
  if (wantsDirect && !DIRECT) {
    // The mode is on but its engine never loaded: fall back to the helper and say why.
    setNote("warn", "Direct is selected but direct.js did not load — reinstall Tracky. Using the local helper for now.");
  }
  $("dkey").value = typeof opts.directKey === "string" ? opts.directKey : "";
  renderRoutes(opts.directSource);
  renderSpend(v.trackySpend);
  applyMode();
  await loadSources(opts.source ?? null);
}

/** The route list a direct-mode user picks from — the same two the helper ships
 *  with in server/.env, declared in direct.js so both modes name models identically. */
function renderRoutes(saved) {
  const sel = $("dsource");
  sel.textContent = "";
  if (!DIRECT) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "direct.js did not load — reinstall Tracky";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  for (const r of DIRECT.ROUTES) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `${r.label} · ${r.model}`;
    sel.appendChild(o);
  }
  sel.value = DIRECT.ROUTES.some((r) => r.id === saved) ? saved : DIRECT.ROUTES[0].id;
}

/** Visibility + the honest copy for whichever mode is selected. */
function applyMode() {
  const direct = isDirect();
  $("direct").hidden = !direct;
  $("helper-note").textContent = direct
    ? "Not used in direct mode — a search goes straight from this extension to the route above. Nothing talks to 127.0.0.1, and no helper has to be running."
    : "If it says the helper is down, start it with node server/server.mjs. Page text goes only to this local helper on 127.0.0.1 — it is never uploaded anywhere else, and the helper logs counts, never text.";
}

/** Direct mode fetches Jev from this extension, so Chrome must grant that origin —
 *  and only a real click can ask. Already granted → true, no prompt. */
async function ensureOriginPermission() {
  try {
    if (await chrome.permissions.contains({ origins: DIRECT_ORIGINS })) return true;
    return await chrome.permissions.request({ origins: DIRECT_ORIGINS });
  } catch {
    return false; // no permissions API answer → the caller says what it means
  }
}

/** Populate the source dropdown from the helper's /api/providers (labels only,
 *  never keys). Offline → one honest option and a note that says to start it.
 *  Direct mode → the helper is not involved at all, so the list says so. */
async function loadSources(saved) {
  const sel = $("source");
  const note = $("source-note");
  if (isDirect()) {
    sel.textContent = "";
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "not used in direct mode";
    sel.appendChild(o);
    sel.disabled = true;
    note.textContent = "Direct mode uses the route under Connect — the helper's sources (server/.env) are not involved.";
    note.className = "muted";
    sourcesData = null; // the listener must not read a stale helper list
    return;
  }
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
  const whyNot = (p) => p.why || "no key yet"; // the helper says why (it knows the URL; we never see it)
  const tagOf = (p) => [p.model, p.kind, p.configured ? "" : whyNot(p)].filter(Boolean).join(" · ");
  // The default row is only disabled when something else can actually be picked.
  add("", `Helper default${defP ? ` — ${defP.label}${defOk ? "" : ` · ${whyNot(defP)}`}` : ""}`, !defOk && Boolean(firstOk));
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
  const lines = $("hosts").value.split("\n");
  // Normalize to hostnames so what is stored is what hostMatches can match.
  // Falls back to the old keep-as-typed filter only if shared.js failed to load.
  const { hosts, dropped } = SHARED
    ? SHARED.normalizeHosts(lines)
    : {
        hosts: lines.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0 && !h.includes(" ") && !h.startsWith("http")),
        dropped: [],
      };
  const note = $("hosts-note");
  if (note) {
    if (dropped.length) {
      const shown = dropped.slice(0, 3).join(", ") + (dropped.length > 3 ? "…" : "");
      note.textContent = `Ignored ${dropped.length} invalid entr${dropped.length === 1 ? "y" : "ies"}: ${shown}`;
      note.className = "warn";
    } else {
      note.textContent = "Alt+K on a listed site does nothing but show a small dash on the icon.";
      note.className = "muted";
    }
  }
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
    mode: isDirect() ? "direct" : "helper",
    directKey: $("dkey").value.trim(),
    directSource: $("dsource").value || DIRECT?.ROUTES[0].id || "",
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
  if (isDirect()) {
    // No helper to ping: say what the mode is, and which of the two things a search would
    // still need — a key, or Chrome's permission for the route's origin (same contract as
    // the in-page panel, so the two never disagree).
    if (!$("dkey").value.trim()) {
      text.textContent = "direct — paste your Jev key in Connect";
      return;
    }
    let granted = true;
    try {
      granted = !DIRECT_ORIGINS.length || (await chrome.permissions.contains({ origins: DIRECT_ORIGINS }));
    } catch {
      /* no answer from the permissions API → do not invent a problem */
    }
    if (!granted) {
      dot.className = "dot bad";
      text.textContent = "direct — allow access to opencode.ai in Connect";
      return;
    }
    text.textContent = "direct — no helper needed";
    return;
  }
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

/** Switching modes re-renders everything that depends on it, and asks for the one
 *  permission direct mode needs — from this click, the only moment Chrome allows it. */
async function onModeChange() {
  const note = $("dtest-note");
  $("mode-note").hidden = true; // a fresh choice starts with a clean slate
  if (isDirect() && !(await ensureOriginPermission())) {
    $("mode-helper").checked = true; // a refused switch is not a switch
    note.textContent = "Permission declined — direct mode needs access to opencode.ai to reach Jev.";
    note.className = "warn";
    // The revert hides the Direct panel, so say it once where it stays visible.
    setNote("warn", "Direct needs permission for opencode.ai — click Direct again and accept the prompt.");
  } else if (isDirect()) {
    note.textContent = $("dkey").value.trim()
      ? "One tiny real call proves the key before you search."
      : "Paste your key above, then press Test — one tiny real call proves it.";
    note.className = "muted";
  }
  applyMode();
  await save();
  const v = await chrome.storage.local.get({ trackyOpts: null });
  await loadSources(v?.trackyOpts?.source ?? null); // re-render as helper list / "not used"
  pingHelper();
}

/** The one credential path in the whole extension: pasted here, stored in this
 *  browser's storage, sent only to the route the user picked. */
$("dtest").addEventListener("click", async () => {
  const note = $("dtest-note");
  const key = $("dkey").value.trim();
  if (!key) {
    note.textContent = "Paste your key first — there is nothing to test yet.";
    note.className = "warn";
    return;
  }
  if (!(await ensureOriginPermission())) {
    note.textContent = "Permission declined — direct mode needs access to opencode.ai to reach Jev.";
    note.className = "warn";
    // The same condition the mode switch reports — say it on the always-visible line too,
    // so one wording covers both places a user can meet it.
    setNote("warn", "Direct needs permission for opencode.ai — click Direct again and accept the prompt.");
    return;
  }
  note.textContent = "testing the key — one small call…";
  note.className = "muted";
  // Locked + spinning for the duration: a second click must not spend a second call,
  // and the wait must be visible rather than a frozen-looking button.
  const btn = $("dtest");
  btn.classList.add("busy");
  btn.disabled = true;
  try {
    if (!DIRECT) {
      note.textContent = "direct.js did not load — reinstall Tracky, then try again.";
      note.className = "warn";
      return;
    }
    const out = await DIRECT.testKey({ config: DIRECT.configFrom({ key, sourceId: $("dsource").value }) });
    note.textContent = `✓ ${out.model} answered in ${out.ms} ms — the key works.`;
    note.className = "ok";
    await save(); // a key that just answered is a key worth keeping
  } catch (e) {
    note.textContent = `✗ ${e?.message ?? e}`;
    note.className = "warn";
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
});

$("mode-helper").addEventListener("change", onModeChange);
$("mode-direct").addEventListener("change", onModeChange);
$("dkey").addEventListener("change", async () => {
  await save();
  pingHelper(); // the status line says whether a key is saved
});
$("dsource").addEventListener("change", save);

// The first ping must wait for load() to restore the saved mode — a ping that runs
// before the storage read would print the helper's line even when the page is about to
// show direct mode, and it would sit there until the 15s tick (caught live, in a shot).
load().finally(pingHelper);
setInterval(pingHelper, 15000); // keep the status honest while the page is open
