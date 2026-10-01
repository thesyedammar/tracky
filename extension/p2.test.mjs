// Patch-batch-3 specs — the 7 extension p2s, behavior-first.
// Pure shared helpers run directly; collector + worker code runs live in vm.
// (The lowercase-<br> fix is DOM-only: source-asserted here, proven on a real
// XHTML page via scripts/ext-smoke.py, which node cannot drive.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import "./shared.js";

const S = globalThis.TrackyShared;
assert.ok(S.isEditableTarget && S.resolveOffset, "shared.js must expose the batch-3 helpers");
const load = (p) => fs.readFileSync(p, "utf8");

// --- p2: Ctrl+F hijack stands down in editors ---
test("isEditableTarget keeps find-in-editor working", () => {
  assert.equal(S.isEditableTarget({ tagName: "TEXTAREA", isContentEditable: false }), true); // Monaco's input area
  assert.equal(S.isEditableTarget({ tagName: "input" }), true); // case-insensitive
  assert.equal(S.isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(S.isEditableTarget({ tagName: "DIV", isContentEditable: true }), true); // Docs, Notion, CodeMirror 6
  assert.equal(S.isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
  assert.equal(S.isEditableTarget({ tagName: "BODY" }), false);
  assert.equal(S.isEditableTarget(null), false);
  assert.equal(S.isEditableTarget(undefined), false);
  assert.equal(S.isEditableTarget("input"), false);
});

test("content.js hijack consults isEditableTarget before opening", () => {
  const src = load("extension/content.js");
  assert.match(src, /TrackyShared\?\.isEditableTarget\(e\.target\)/);
});

// --- p2: highlight position refuses the wrong repeat ---
test("resolveOffset verifies, falls back to unique, refuses ambiguous", () => {
  const text = "alpha beta gamma. delta epsilon. alpha beta gamma.";
  const second = text.indexOf("alpha beta gamma.", 1); // never hand-count fixtures
  assert.equal(S.resolveOffset(text, 0, "alpha beta gamma."), 0); // verified offset wins
  assert.equal(S.resolveOffset(text, second, "alpha beta gamma."), second); // …even the second repeat
  assert.equal(S.resolveOffset("only here xyz. pad pad", 999, "only here xyz."), 0); // wrong offset, unique
  assert.equal(S.resolveOffset("only here xyz.", NaN, "only here xyz."), 0); // missing offset, unique
  assert.equal(S.resolveOffset(text, 5, "alpha beta gamma."), -1); // wrong offset, repeated: no guess
  assert.equal(S.resolveOffset(text, NaN, "alpha beta gamma."), -1); // missing offset, repeated: no guess
  assert.equal(S.resolveOffset(text, 0, "nope nope"), -1);
  assert.equal(S.resolveOffset(text, 0, ""), -1);
  assert.equal(S.resolveOffset(null, 0, "x"), -1);
});

test("content.js rangeForHit resolves through shared, with a missing-Shared fallback", () => {
  const src = load("extension/content.js");
  // Bounded region, no regex: everything between rangeForHit and the next
  // top-level function belongs to the hit resolver.
  const head = src.split("function rangeForHit");
  assert.ok(head.length > 1, "rangeForHit must exist in content.js");
  const region = head[1].split("function rangeFor(")[0];
  assert.ok(region.includes('typeof r.sentence !== "string"'),
    "a result without sentence text returns null, never throws");
  assert.ok(region.includes('typeof block?.text !== "string"'),
    "a registry entry without text returns null, never throws");
  assert.ok(region.includes('typeof resolve === "function"'), "shared path must be guarded, never assumed");
  assert.ok(region.includes("resolve(block.text, off, r.sentence)"), "shared resolveOffset stays the primary path");
  assert.ok(!region.includes("?? -1"), "rangeForHit must never hard-fail a missing Shared as 'page changed'");
  assert.ok(region.includes("Number.isFinite(pos)"), "a non-finite position must never reach the segment map");
  assert.ok(region.includes("pos < 0"), "a negative position returns null, never a collapsed range");
  assert.ok(!/\?\?\s*-1/.test(region), "no ?? -1 in any spacing — a missing Shared must fail open, not silent");
  assert.ok(region.includes("const verified = Number.isFinite(off) && off >= 0"),
    "the fallback verifies its own offset before trusting it");
  const tpos = region.indexOf('typeof resolve === "function"');
  const respos = region.indexOf("? resolve(block.text, off, r.sentence)");
  const fbpos = region.indexOf(": verified");
  assert.ok(tpos !== -1 && respos !== -1 && fbpos !== -1 && tpos < respos && respos < fbpos,
    "shared resolves when present, verified-offset fallback otherwise — linked in one ternary");
  const sliceAt = region.indexOf("block.text.slice(off, off + r.sentence.length)");
  const indexAt = region.indexOf("block.text.indexOf(r.sentence)");
  assert.ok(sliceAt !== -1 && indexAt !== -1 && sliceAt < indexAt,
    "fallback order is fixed: verified offset first, first occurrence last");
});

test("pdf.html script order is synchronous and Shared-first", () => {
  const html = load("extension/pdf.html");
  for (const tag of ['src="shared.js"', 'src="content.js"']) {
    const at = html.indexOf(tag);
    const open = html.lastIndexOf("<script", at);
    const close = html.indexOf(">", at);
    const head = html.slice(open, close);
    assert.ok(!/async|defer|type\s*=\s*["']module["']/.test(head), `${tag} must be a classic ordered script`);
  }
});

test("pdf.html loads shared.js before content.js (the reader has no injector)", () => {
  const html = load("extension/pdf.html");
  const sharedAt = html.indexOf('src="shared.js"');
  const contentAt = html.indexOf('src="content.js"');
  assert.ok(sharedAt !== -1, "pdf.html must load shared.js - background.js never injects into the reader");
  assert.ok(contentAt !== -1);
  assert.ok(sharedAt < contentAt, "shared.js must come first so rangeForHit can resolve");
});

// --- p2: stale collector reinstalls after an update, live in vm ---
function loadCollect({ version, seed } = {}) {
  const sandbox = {
    console,
    window: {},
    chrome: version == null ? {} : { runtime: { getManifest: () => ({ version }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (seed !== undefined) sandbox.window.__trackyCollect = seed;
  vm.runInContext(load("extension/collect.js"), sandbox, { filename: "collect.js" });
  return sandbox;
}

test("collector reinstalls on version change, stays on identical version", () => {
  const stale = { v: "0.7.2" };
  const sb1 = loadCollect({ version: "0.7.3", seed: stale });
  assert.notEqual(sb1.window.__trackyCollect, stale, "stale version must reinstall");
  assert.equal(typeof sb1.window.__trackyCollect, "function");
  assert.equal(sb1.window.__trackyCollect.v, "0.7.3");
  const keep = { v: "0.7.3" };
  const sb2 = loadCollect({ version: "0.7.3", seed: keep });
  assert.equal(sb2.window.__trackyCollect, keep, "identical version keeps the installed collector");
  const sb3 = loadCollect({ seed: { v: "whatever" } }); // no chrome.runtime: old-guard behavior
  assert.equal(typeof sb3.window.__trackyCollect, "function");
  assert.equal(sb3.window.__trackyCollect.v, "0");
});

// --- p2: lowercase <br> (DOM-only: no DOM in node) ---
test("collector treats lowercase br as a line break", () => {
  const src = load("extension/collect.js");
  assert.ok(!src.includes('node.tagName === "BR"'), "case-sensitive check must be gone");
  assert.match(src, /\(node\.tagName \|\| ""\)\.toUpperCase\(\) === "BR"/);
});

// --- p2: worker liveness — pdfOffer prune + per-tab char share, live in vm ---
function loadBg({ tabs = [], storageOpts = {}, failScripting = false, onFunc } = {}) {
  const listeners = {};
  const calls = { executeScript: [], permissionsRequest: [], sendMessage: [] };
  const sandbox = {
    console, TextEncoder, TextDecoder, AbortSignal, URL,
    decodeURIComponent, encodeURIComponent,
    setTimeout, clearTimeout, performance,
    chrome: {
      tabs: {
        onRemoved: { addListener: (fn) => (listeners.onRemoved = fn) },
        query: async () => tabs,
        sendMessage: async (id, msg) => { calls.sendMessage.push([id, msg]); },
        create: async () => ({}),
      },
      action: {
        onClicked: { addListener: (fn) => (listeners.onClicked = fn) },
        setTitle: async () => {},
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
      },
      runtime: {
        onMessage: { addListener: (fn) => (listeners.onMessage = fn) },
        getURL: (p) => `chrome-extension://x/${p}`,
      },
      storage: { local: { get: async () => ({ trackyOpts: storageOpts }) } },
      scripting: {
        executeScript: async (req) => {
          calls.executeScript.push(req);
          if (failScripting) throw new Error("cannot script this page");
          if (req.func && onFunc) return [{ result: onFunc(req) }];
          return [{}];
        },
      },
      permissions: {
        request: async (o) => (calls.permissionsRequest.push(o), true),
        contains: async () => true,
      },
      extension: { isAllowedFileSchemeAccess: async () => false },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(load(`extension/${f}`), sandbox, { filename: f });
  };
  vm.runInContext(load("extension/background.js"), sandbox, { filename: "background.js" });
  assert.ok(listeners.onClicked && listeners.onRemoved, "worker must wire click + tab-close listeners");
  return { sandbox, listeners, calls };
}

test("closed tab's PDF offer dies with it — live worker in vm", async () => {
  const { listeners, calls } = loadBg({ failScripting: true });
  const tick = () => new Promise((r) => setTimeout(r, 50)); // onClicked is sync: openPanel lands a tick later
  await listeners.onClicked({ id: 7, url: "https://example.com/article" }); // scripting fails: offer planted
  await tick();
  listeners.onRemoved(7); // tab closed before the second click
  await listeners.onClicked({ id: 7, url: "https://example.com/other" }); // a new tab reusing id 7
  await tick();
  assert.equal(calls.permissionsRequest.length, 0, "no reader permission request for the reused id");
  assert.equal(calls.executeScript.filter((r) => r.files).length, 2, "both clicks took the panel path");
});

test("control: second click on the same unclosed tab still offers the reader", async () => {
  const { listeners, calls } = loadBg({ failScripting: true });
  const tick = () => new Promise((r) => setTimeout(r, 50));
  await listeners.onClicked({ id: 7, url: "https://example.com/article" });
  await tick();
  await listeners.onClicked({ id: 7, url: "https://example.com/article" });
  await tick();
  assert.equal(calls.permissionsRequest.length, 1, "the offer itself must keep working");
});

test("cross-tab collect asks each tab for at most its char share — live worker in vm", async () => {
  const tabs = [
    { id: 1, url: "https://a.example/", title: "A" },
    { id: 2, url: "https://b.example/", title: "B" },
    { id: 3, url: "https://c.example/", title: "C" },
  ];
  const asked = [];
  const { sandbox } = loadBg({
    tabs,
    storageOpts: { crossTab: true },
    onFunc: (req) => {
      // the injected page-side func runs against the tab's own window
      const page = { __trackyCollect: (o) => (asked.push(o), { blocks: [] }) };
      const realWindow = sandbox.window;
      sandbox.window = page;
      try {
        return req.func(...req.args);
      } finally {
        sandbox.window = realWindow;
      }
    },
  });
  const out = await vm.runInContext("collectFromTabs(99, 600)", sandbox);
  assert.equal(out.tabs.length, 0, "empty canned blocks collect nothing, but the ask is what this proves");
  assert.equal(asked.length, 3, "one collect call per candidate tab");
  for (const o of asked) {
    // field-by-field: cross-realm objects fail deepEqual on prototype, not content
    assert.equal(o.maxBlocks, 200, "600/3 passages per tab");
    assert.equal(o.maxChars, 133333, "400000/3 chars per tab");
  }
});

// --- p2: SPA watcher lives only while the panel is open ---
test("spa watcher arms on open and dies on close", () => {
  const src = load("extension/content.js");
  assert.match(src, /let spaTimer = null;/);
  assert.match(src, /armSpaWatcher\(\); \/\/ the URL watcher lives only while the panel does/);
  assert.match(src, /clearInterval\(spaTimer\); \/\/ the watcher dies with the panel/);
  assert.ok(!src.match(/^\s*setInterval\(\(\) => \{\s*$/m), "bare forever-interval must be gone");
});
