// Patch-batch-1 specs — proves the 5 extension p1 fixes with real behavior.
// shared.js is a classic script (importScripts in the worker, <script> on the
// options page and the panel), so it is imported here for its side effect.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import "./shared.js";

const S = globalThis.TrackyShared;
assert.ok(S, "shared.js must expose globalThis.TrackyShared");

// --- Bug 4 core: SSE framing on raw bytes ---
test("findSseBoundary accepts LF, CRLF, lone-CR and mixed framing", () => {
  assert.deepEqual(S.findSseBoundary("event: a\ndata: 1\n\nrest"), { index: 16, length: 2 });
  assert.deepEqual(S.findSseBoundary("event: a\r\ndata: 1\r\n\r\nrest"), { index: 17, length: 4 });
  assert.deepEqual(S.findSseBoundary("event: a\rdata: 1\r\r"), { index: 16, length: 2 });
  assert.deepEqual(S.findSseBoundary("event: a\n\rev ent"), { index: 8, length: 2 }); // \n\r is itself a blank line
  assert.deepEqual(S.findSseBoundary("a\r\n\rb"), { index: 1, length: 3 }); // mixed CRLF + lone CR
  assert.equal(S.findSseBoundary("event: result\r"), null); // trailing CR held for the next read
  assert.equal(S.findSseBoundary("event: result"), null);
  // the killer case: CR at end of read 1 + LF at start of read 2 is ONE line break
  let buf = "event: result\r";
  assert.equal(S.findSseBoundary(buf), null);
  buf += "\ndata: {\"x\":1}\n\n";
  const cut = S.findSseBoundary(buf);
  assert.ok(cut && buf.slice(0, cut.index) === "event: result\r\ndata: {\"x\":1}");
});

test("parseSseFrame handles CRLF, lone-CR, no-space data and multi-line data", () => {
  assert.deepEqual(S.parseSseFrame("event: result\r\ndata: {\"x\":1}"), { ev: "result", data: "{\"x\":1}" });
  assert.deepEqual(S.parseSseFrame("event: progress\rdata: 5"), { ev: "progress", data: "5" });
  assert.deepEqual(S.parseSseFrame("event: result\ndata:{\"x\":1}"), { ev: "result", data: "{\"x\":1}" });
  assert.deepEqual(S.parseSseFrame("event: result\ndata: line1\ndata: line2"), { ev: "result", data: "line1\nline2" });
  assert.equal(S.parseSseFrame(": heartbeat"), null);
  assert.equal(S.parseSseFrame("data: 1"), null); // no event line
  assert.equal(S.parseSseFrame("event: "), null); // empty event
  assert.equal(S.parseSseFrame("   \n  "), null);
});

test("helperSearchStream consumes the shared parser (single frame path)", () => {
  const src = fs.readFileSync("extension/background.js", "utf8");
  assert.match(src, /parseSseFrame\(frame\)/);
  assert.match(src, /findSseBoundary\(buf\)/);
  assert.ok(!src.includes('buf.indexOf("\\n\\n")'), "LF-only split must be gone");
  assert.match(src, /if \(buf\) handleFrame\(buf\)/);
});

// --- Bug 1: cross-tab progress wiring, exercised live in a vm worker ---
test("searchWithTabs forwards currentTabId — live background wiring in vm", async () => {
  const load = (p) => fs.readFileSync(p, "utf8");
  const sandbox = {
    console,
    chrome: {
      tabs: { onRemoved: { addListener() {} } },
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(load(`extension/${f}`), sandbox, { filename: f });
  };
  vm.runInContext(load("extension/background.js"), sandbox, { filename: "background.js" });
  assert.equal(typeof sandbox.searchWithTabs, "function", "worker must define searchWithTabs");
  // stub the boundaries: other-tabs collection + the actual search engine
  vm.runInContext(`collectFromTabs = async () => ({
    on: true,
    tabs: [{ tabId: 9, title: "Other", url: "https://other.example/", blocks: [{ id: "b0", text: "words from the other tab here" }] }],
    skipped: { budget: 0 },
  });`, sandbox);
  vm.runInContext(`runSearch = async (req, tabId) => { globalThis.__seenTabId = tabId; return { results: [] }; };`, sandbox);
  const out = await vm.runInContext(
    `searchWithTabs({ query: "q", passages: [{ id: "p0", text: "local page words here" }], currentTabId: 7 })`,
    sandbox,
  );
  assert.equal(sandbox.__seenTabId, 7, "merged cross-tab search must carry the current tab id for progress routing");
  assert.equal(out.crossTab.enabled, true);
});

// --- Bug 2: dedupe parity (mirrored expression, same precedent as hostMatches) ---
test("collect.js and pdf-viewer.js share the identical full-text key", () => {
  const collect = fs.readFileSync("extension/collect.js", "utf8");
  const pdf = fs.readFileSync("extension/pdf-viewer.js", "utf8");
  const expr = 'trimmed.replace(/\\s+/g, " ").toLowerCase()';
  assert.ok(collect.includes(expr), "collect.js must use the full-text key");
  assert.ok(pdf.includes(expr), "pdf-viewer.js must use the same key");
  assert.ok(!collect.includes("slice(0, 160)"), "truncated key must be gone");
  assert.ok(!pdf.includes("slice(0, 160)"), "truncated key must be gone in pdf-viewer too");
  // the full-text keys are bounded, not unbounded: the collector caps the input
  const collectSrc = collect;
  assert.match(collectSrc, /MAX_BLOCKS = 600/);
  assert.match(collectSrc, /MAX_CHARS = 400_000/);
  // behavior of the expression itself: shared-prefix long blocks stay distinct
  const key = (s) => s.replace(/\s+/g, " ").toLowerCase();
  const a = "lorem ipsum dolor sit amet ".repeat(10) + "ENDING-A";
  const b = "lorem ipsum dolor sit amet ".repeat(10) + "ENDING-B";
  assert.ok(a.slice(0, 160) === b.slice(0, 160), "fixture shares a 160-char prefix");
  assert.ok(key(a) !== key(b), "full-text keys keep both blocks");
});

// --- Bug 3: direct-mode error surface, pure selector fully mapped ---
test("searchErrorStatus maps every health state", () => {
  const f = S.searchErrorStatus;
  assert.equal(f({ isDirectMode: true, hasHealth: true, pingFailed: false }, "timeout X"), "search timed out — timeout X");
  assert.equal(f({ isDirectMode: true, hasHealth: true, pingFailed: false }, "boom"), "search failed — boom");
  assert.equal(f({ isDirectMode: true, hasHealth: false, pingFailed: true }, ""), "search failed — unknown error");
  assert.equal(f({ isDirectMode: false, hasHealth: true, pingFailed: false }, "timeout X"), "search timed out — is the helper healthy?");
  assert.equal(f({ isDirectMode: false, hasHealth: true, pingFailed: false }, "boom"), S.HELPER_FIX);
  assert.equal(f({ isDirectMode: false, hasHealth: false, pingFailed: true }, "boom"), S.HELPER_FIX);
  assert.equal(f({ isDirectMode: false, hasHealth: false, pingFailed: true }, "timeout X"), "search timed out — is the helper healthy?");
  assert.equal(f({ isDirectMode: false, hasHealth: false, pingFailed: false }, "boom"), "search failed — boom");
  assert.equal(f({ isDirectMode: false, hasHealth: false, pingFailed: false }, "timeout X"), "search timed out — timeout X");
  assert.equal(f({ isDirectMode: false, hasHealth: false, pingFailed: false }, "   "), "search failed — unknown error");
});

test("content.js tracks all three health flags and uses the shared selector", () => {
  const src = fs.readFileSync("extension/content.js", "utf8");
  assert.match(src, /let isDirectMode = false/);
  assert.match(src, /let hasHealth = false/);
  assert.match(src, /let pingFailed = false/);
  assert.match(src, /isDirectMode = false;\n\s+hasHealth = false;\n\s+pingFailed = true;/); // stale flags die with the signal
  assert.match(src, /TrackyShared\?\.searchErrorStatus/);
  const bg = fs.readFileSync("extension/background.js", "utf8");
  assert.match(bg, /files: \["collect\.js", "shared\.js", "content\.js"\]/); // shared rides with the panel
});

// --- Bug 5: deny-list normalization incl. live IPv6 semantics ---
test("normalizeHosts keeps matchable hosts, drops the rest visibly", () => {
  const { hosts, dropped } = S.normalizeHosts([
    "https://example.com",
    "example.com/path",
    "https://user@example.com:8080/a",
    "user@example.com", // schemeless user@host is ambiguous: dropped visibly
    "localhost",
    "my_intranet",
    "[::1]:8080",
    "bad entry",
    "example.com/path://evil",
    "example..com",
    "host:abc",
    "-",
    "",
    "example.com",
  ]);
  assert.deepEqual(hosts, ["example.com", "localhost", "my_intranet", "[::1]"]);
  assert.deepEqual(dropped, ["user@example.com", "bad entry", "example.com/path://evil", "example..com", "host:abc", "-"]);
  // live deny path: stored entries match real location.hostnames, IPv6 included
  assert.ok(S.hostDenied("example.com", hosts));
  assert.ok(S.hostDenied("sub.example.com", hosts));
  assert.ok(S.hostDenied("[::1]", hosts), "bracketed IPv6 entry must match an IPv6 page host");
  assert.ok(!S.hostDenied("other.com", hosts));
});

test("options page wires shared.js and the note element (no alert fallback)", () => {
  const html = fs.readFileSync("extension/options.html", "utf8");
  assert.match(html, /id="hosts-note"/);
  assert.match(html, /<script src="shared\.js"><\/script>/);
  const js = fs.readFileSync("extension/options.js", "utf8");
  assert.match(js, /SHARED\.normalizeHosts\(lines\)/);
  assert.ok(!js.includes("alert("), "blocking alert must be gone");
});

// --- Bugs 1+4 end to end: the REAL worker functions, stubbed only at the edges ---
function loadWorker(chunks) {
  const load = (p) => fs.readFileSync(p, "utf8");
  const enc = new TextEncoder();
  const sent = [];
  const sandbox = {
    console, TextEncoder, TextDecoder, AbortSignal,
    fetch: async () => ({
      ok: true,
      headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: {
        getReader() {
          let i = 0;
          return {
            read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }),
          };
        },
      },
    }),
    chrome: {
      tabs: { onRemoved: { addListener() {} }, sendMessage: async (tabId, msg) => { sent.push([tabId, msg]); } },
      action: { onClicked: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async () => ({}) } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(load(`extension/${f}`), sandbox, { filename: f });
  };
  vm.runInContext(load("extension/background.js"), sandbox, { filename: "background.js" });
  return { sandbox, sent };
}

test("runSearch routes stream progress to the calling tab — live worker in vm", async () => {
  const { sandbox, sent } = loadWorker([
    'event: progress\r\ndata: {"done":1}\r\n\r\n',
    'event: result\r\ndata: {"results":[],"stats":{"ms":5}}', // no trailing blank: tail-flush path
  ]);
  const out = await vm.runInContext(`runSearch({ query: "q", passages: [{ id: "p0", text: "local page words here" }] }, 7)`, sandbox);
  assert.equal(out.stats.ms, 5, "tail frame without trailing blank must still resolve");
  const progress = sent.filter(([id, m]) => id === 7 && m?.type === "tracky:progress");
  assert.equal(progress.length, 1, "one progress event must reach tab 7 through the real runSearch");
  assert.equal(progress[0][1].done, 1);
});

test("helperSearchStream error frame throws helperDown=false — live worker in vm", async () => {
  const { sandbox } = loadWorker(['event: error\r\ndata: {"message":"quota nap","status":429}\n\n']);
  await assert.rejects(
    vm.runInContext(`helperSearchStream({ query: "q", passages: [] }, () => {})`, sandbox),
    (e) => e?.message === "quota nap" && e?.helperDown === false,
  );
});
