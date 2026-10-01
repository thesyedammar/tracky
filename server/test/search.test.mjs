// Engine specs — chunking, merging, dedupe, progress, and every failure mode.
import test from "node:test";
import assert from "node:assert/strict";
import { searchText, dedupeResults } from "../search.mjs";
import { clampCallTimeout } from "../search.mjs";
import { SearchError } from "../validate.mjs";
import { BATCH_MAX } from "../jev.mjs";

const config = { baseUrl: "https://jev.test", model: "jev-t", apiKey: "k" };

const response = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

const makePassages = (n, tpl = (i) => `Passage ${i} has a fee. Something else.`) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: tpl(i) }));

const allRelevant = (body, score = 0.9, pick = "s0") => {
  const answers = {};
  for (const p of body.state.passages) {
    answers[p.id] = { type: "noul", noul: score };
    if (body.questions[`focus_${p.id}`]) answers[`focus_${p.id}`] = { type: "choice", choice: pick };
  }
  return answers;
};

test("small batch: one request, ranked results with exact sentences", async () => {
  let calls = 0;
  let seenBody;
  const fetchImpl = async (url, init) => {
    calls++;
    seenBody = JSON.parse(init.body);
    assert.equal(url, config.baseUrl);
    assert.match(init.headers.Authorization, /^Bearer /);
    return response({ answers: allRelevant(seenBody), usage: { input_tokens: 100, output_tokens: 20 } });
  };
  const { results, stats } = await searchText({ query: "fee", passages: makePassages(3) }, { config, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(seenBody.model, "jev-t");
  assert.equal(seenBody.state.search, "fee");
  assert.equal(stats.chunks, 1);
  assert.deepEqual(stats.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(results.length, 3);
  assert.equal(results[0].sentence, "Passage 0 has a fee.");
  assert.equal(results[0].score, 0.9);
  assert.equal(typeof results[0].offset, "number");
  for (const r of results) {
    const src = makePassages(3).find((p) => p.id === r.passageId);
    assert.ok(src.text.includes(r.sentence));
  }
});

test("large set: chunks into BATCH_MAX passes and merges", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return response({ answers: allRelevant(body, 0.7, "s0"), usage: { input_tokens: 10, output_tokens: 2 } });
  };
  const n = BATCH_MAX + 5;
  const { results, stats } = await searchText({ query: "fee", passages: makePassages(n) }, { config, fetchImpl });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].state.passages.length, BATCH_MAX);
  assert.equal(bodies[1].state.passages.length, 5);
  assert.equal(stats.chunks, 2);
  assert.equal(stats.usage.input_tokens, 20);
  assert.equal(results.length, 8); // all 85 clear the band; the cap bites
});

test("reports progress per pass", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => response({ answers: allRelevant(JSON.parse(init.body)) });
  await searchText(
    { query: "fee", passages: makePassages(BATCH_MAX + 1) },
    { config, fetchImpl, onProgress: (p) => seen.push(p) },
  );
  assert.deepEqual(
    seen.map((p) => [p.chunk, p.chunks, p.done, p.total]),
    [
      [1, 2, BATCH_MAX, BATCH_MAX + 1],
      [2, 2, BATCH_MAX + 1, BATCH_MAX + 1],
    ],
  );
});

test("identical sentences across passages collapse to the best hit", () => {
  const parsed = [
    { id: "p0", score: 0.7, focusText: "Subscribe to our newsletter.", focusIndex: 0, choiceProbabilities: null },
    { id: "p1", score: 0.9, focusText: "Subscribe to our newsletter.", focusIndex: 0, choiceProbabilities: null },
    { id: "p2", score: 0.8, focusText: "Unique line.", focusIndex: 0, choiceProbabilities: null },
  ];
  const out = dedupeResults(parsed);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.focusText === "Subscribe to our newsletter.").id, "p1");
});

test("a failing pass fails the whole search (never partial truth)", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    if (calls === 2) return response("boom", { ok: false, status: 500 });
    return response({ answers: allRelevant(JSON.parse(init.body)) });
  };
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(BATCH_MAX + 1) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 502,
  );
});

test("a 429 says how long the quota window is, not 'a moment'", async () => {
  const withWait = async () => ({
    ok: false,
    status: 429,
    headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "5975" : null) },
    text: async () => '{"type":"error"}',
  });
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl: withWait }),
    (e) => e instanceof SearchError && e.status === 502 && /rate-limited/.test(e.message) && /100 minutes/.test(e.message),
  );
  const noHeader = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => "nope",
  });
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl: noHeader }),
    (e) => e instanceof SearchError && /rate-limited — try again in a few minutes/.test(e.message),
  );
});

// ---------------------------------------------------------------- Phase 11.2
// Forced-bad-answer tests: when the model misbehaves, the app must fail loudly —
// it may never invent a sentence, guess an index, or answer about a passage that
// does not exist. Each test below feeds a deliberately bad reply and asserts both
// the rejection AND that nothing fabricated escapes.

test("a fabricated sentence can never leak: text comes from the passage, not the reply", async () => {
  // The model's own `text` field is never trusted — the sentence is taken from OUR
  // sentence list by index and re-verified as an exact slice. So a fluent invention
  // riding along with a valid index must not appear anywhere in the results.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const p of body.state.passages) {
      answers[p.id] = { type: "noul", noul: 0.95 };
      if (body.questions[`focus_${p.id}`]) {
        answers[`focus_${p.id}`] = {
          type: "choice",
          choice: "s0",
          text: "A late fee of Rs.500 applies to every booking.", // invented, never used
        };
      }
    }
    return response({ answers });
  };
  const { results } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.sentence, `Passage ${r.passageId.slice(1)} has a fee.`); // its own passage's sentence
    assert.ok(!JSON.stringify(r).includes("Rs.500"), "the invented sentence must not escape anywhere");
  }
});

test("a reply cannot smuggle its own offset or text — both come from our splitter", async () => {
  // The sentence and its offset are produced by OUR splitSentences() and re-verified
  // as an exact slice. A reply that also sends `text`/`start` fields must not be able
  // to shift, extend, or replace what gets highlighted.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const p of body.state.passages) {
      answers[p.id] = { type: "noul", noul: 0.9 };
      if (body.questions[`focus_${p.id}`]) {
        answers[`focus_${p.id}`] = { type: "choice", choice: "s0", start: 999, text: "totally different" };
      }
    }
    return response({ answers });
  };
  const { results } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.sentence, `Passage ${r.passageId.slice(1)} has a fee.`);
    assert.equal(r.offset, 0); // the splitter's offset, not the reply's 999
    assert.ok(!JSON.stringify(r).includes("totally different"));
  }
});

test("an out-of-range sentence index fails the search", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const p of body.state.passages) {
      answers[p.id] = { type: "noul", noul: 0.9 };
      if (body.questions[`focus_${p.id}`]) answers[`focus_${p.id}`] = { type: "choice", choice: "s7" }; // only s0/s1 exist
    }
    return response({ answers });
  };
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 502 && /bad sentence pick/.test(e.message),
  );
});

test("answers about a passage that was never sent are ignored, never surfaced", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = allRelevant(body);
    answers.p99 = { type: "noul", noul: 0.99 }; // invented id
    return response({ answers });
  };
  const { results } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl });
  assert.deepEqual(
    results.map((r) => r.passageId).sort(),
    ["p0", "p1"],
  );
  assert.ok(!JSON.stringify(results).includes("p99"), "an unknown passage id must not surface");
});

test("a score outside 0..1 is rejected, not clamped into a result", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    return response({ answers: allRelevant(body, 7.5) }); // nonsense confidence
  };
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 502 && /bad score/.test(e.message),
  );
});

test("a reply with no answers object fails loudly", async () => {
  const fetchImpl = async () => response({ whatever: true });
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 502 && /missing answers/.test(e.message),
  );
});

// AbortSignal.timeout timers are unref'd in Node — a bare test process would
// drain the event loop before the abort fires. Hold the loop until it does.
const hangingFetch = () => (url, init) =>
  new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error("never resolved")), 60_000);
    init.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(init.signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

test("a hanging Jev times out as a clean 502", async () => {
  const fetchImpl = hangingFetch();
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl, timeoutMs: 15 }),
    (e) => e instanceof SearchError && e.status === 502 && /too long/i.test(e.message),
  );
});

test("an outer cancel reports as cancelled, not an error", async () => {
  const ctrl = new AbortController();
  const fetchImpl = hangingFetch();
  const p = searchText(
    { query: "fee", passages: makePassages(1) },
    { config, fetchImpl, timeoutMs: 5000, signal: ctrl.signal },
  );
  setTimeout(() => ctrl.abort(new Error("stop")), 10);
  await assert.rejects(p, (e) => e instanceof SearchError && e.status === 499);
});

test("missing config is a clear 500", async () => {
  await assert.rejects(searchText({ query: "q", passages: makePassages(1) }), (e) => e instanceof SearchError && e.status === 500);
});

test("engine re-validates its input", async () => {
  await assert.rejects(
    searchText({ query: "  ", passages: makePassages(1) }, { config }),
    (e) => e instanceof SearchError && e.status === 400,
  );
});

test("plumbing guards: bad timeout and bad fetchImpl are clean 500s", async () => {
  for (const t of [0, -5, NaN]) {
    await assert.rejects(
      searchText({ query: "fee", passages: makePassages(1) }, { config, timeoutMs: t }),
      (e) => e instanceof SearchError && e.status === 500,
    );
  }
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, fetchImpl: "nope" }),
    (e) => e instanceof SearchError && e.status === 500,
  );
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, rank: "nope" }),
    (e) => e instanceof SearchError && e.status === 500,
  );
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, onProgress: "nope" }),
    (e) => e instanceof SearchError && e.status === 500,
  );
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(1) }, { config, signal: 123 }),
    (e) => e instanceof SearchError && e.status === 500,
  );
  // rank: null means "no overrides" — it must work, not crash.
  const ok = await searchText(
    { query: "fee", passages: makePassages(1) },
    { config, rank: null, fetchImpl: async (u, i) => response({ answers: allRelevant(JSON.parse(i.body)) }) },
  );
  assert.equal(ok.results.length, 1);
});

// --------------------------------------------- the model's own token cap (max_tokens_exceeded)

test("chunkPrepared: chunks are sized by the request, not by passage count", async () => {
  const { chunkPrepared, MAX_BODY_CHARS } = await import("../search.mjs");
  const { preparePassages } = await import("../jev.mjs");
  const { buildRequest } = await import("../jev.mjs");
  const passages = makePassages(100, (i) => `Dense passage ${i}. `.repeat(120));
  const chunks = chunkPrepared(preparePassages(passages), { maxBodyChars: MAX_BODY_CHARS });
  assert.ok(chunks.length > 2, `dense text must chunk below BATCH_MAX (got ${chunks.length})`);
  assert.deepEqual(chunks.flat().map((p) => p.id), passages.map((p) => p.id), "order preserved, nothing dropped");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= BATCH_MAX, "never more passages than the batch cap");
    const len = JSON.stringify(buildRequest({ query: "fee", passages: chunk, model: config.model })).length;
    assert.ok(len <= MAX_BODY_CHARS, `body ${len} must stay under ${MAX_BODY_CHARS}`);
  }
});

test("chunkPrepared: ordinary pages still ride the full 80-per-request batching", async () => {
  const { chunkPrepared, MAX_BODY_CHARS } = await import("../search.mjs");
  const { preparePassages } = await import("../jev.mjs");
  const chunks = chunkPrepared(preparePassages(makePassages(161)), { maxBodyChars: MAX_BODY_CHARS });
  assert.deepEqual(chunks.map((c) => c.length), [80, 80, 1]);
});

test("chunkPrepared: control chars that explode under JSON escaping still fit", async () => {
  // "\u0001" is 1 char but 6 on the wire (`\u0001`); 80 such passages at a
  // text*2 estimate would pack ~27/chunk for a ~357k body against the 140k
  // budget. The estimator must bound the SERIALIZED size, not the length.
  const { chunkPrepared, MAX_BODY_CHARS } = await import("../search.mjs");
  const { preparePassages, buildRequest } = await import("../jev.mjs");
  const passages = makePassages(80, (i) => `p${i} ${"".repeat(2200)}`.slice(0, 2200));
  const chunks = chunkPrepared(preparePassages(passages), { maxBodyChars: MAX_BODY_CHARS });
  assert.ok(chunks.length > 2, `adversarial text must split small (got ${chunks.length} chunks)`);
  assert.deepEqual(chunks.flat().map((p) => p.id), passages.map((p) => p.id), "order preserved, nothing dropped");
  for (const chunk of chunks) {
    const len = JSON.stringify(buildRequest({ query: "fee", passages: chunk, model: config.model })).length;
    assert.ok(len <= MAX_BODY_CHARS, `escaped body ${len} must stay under ${MAX_BODY_CHARS}`);
  }
});

test("progress never reports pass N of M with N > M, even under 413-halving", async () => {
  const events = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (init.body.length > 40_000) {
      return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
    }
    return response({ answers: allRelevant(body), usage: {} });
  };
  const { stats } = await searchText(
    { query: "fee", passages: makePassages(100, (i) => `Dense passage ${i}. `.repeat(120)) },
    { config, fetchImpl, onProgress: (p) => events.push({ ...p }) },
  );
  assert.ok(stats.requests > stats.chunks, "halving must happen for this fixture");
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.ok(e.chunk <= e.chunks, `pass ${e.chunk} of ${e.chunks} must never invert`);
    assert.equal(e.chunks, stats.chunks);
    assert.equal(e.total, 100);
  }
  assert.equal(events[events.length - 1].chunk, stats.chunks, "the final event reports the final pass");
  assert.equal(events[events.length - 1].chunks, stats.chunks);
  // Sub-pass successes must report their top-level pass, not mint new ones:
  // some index repeats (halving happened), and indices never step backwards.
  const perPass = new Map();
  for (const e of events) perPass.set(e.chunk, (perPass.get(e.chunk) ?? 0) + 1);
  assert.ok([...perPass.values()].some((n) => n > 1), "halved sub-passes must share one pass index");
  assert.ok(events.every((e, i, a) => i === 0 || e.chunk >= a[i - 1].chunk), "pass indices never step backwards");
  assert.equal(events.at(-1).done, 100);
});

test("searchText: a 'too big' answer halves the chunk and still sweeps every passage", async () => {
  // The route rejects any request over 40k body chars with the real 400 shape; the
  // engine must halve and retry instead of failing the whole document.
  const seen = new Set();
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (init.body.length > 40_000) {
      return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
    }
    for (const p of body.state.passages) seen.add(p.id);
    return response({ answers: allRelevant(body) });
  };
  const { stats } = await searchText({ query: "fee", passages: makePassages(100, (i) => `Dense passage ${i}. `.repeat(120)) }, { config, fetchImpl });
  assert.equal(seen.size, 100, "every passage must reach the model, via however many halves it takes");
  assert.ok(calls > stats.chunks, `halving must add requests (calls ${calls} vs chunks ${stats.chunks})`);
  assert.equal(stats.requests, calls);
});

test("engine defaults mirror extension/direct.js (values only, not semantics)", async (t) => {
  // The server and the panel are separate runtimes with no shared module: the
  // ONLY coupling is these default values (gate structures intentionally
  // differ — server clamps per-call off a 1 ms floor, the panel aborts past
  // its budget off a 1 s floor). If either side's literal drifts, this goes
  // red — update server/search.mjs and extension/direct.js together.
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../search.mjs", import.meta.url), "utf8");
  let panel;
  try {
    panel = await readFile(new URL("../../extension/direct.js", import.meta.url), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") {
      t.skip("extension/direct.js absent (server-only checkout) — default mirror unchecked");
      return;
    }
    throw e;
  }
  for (const name of ["DEFAULT_BUDGET_MS", "DEFAULT_TIMEOUT_MS"]) {
    const val = (src) => src.split(`const ${name} = `)[1].split(";")[0].replace(/_/g, "");
    assert.ok(val(server) !== undefined && val(panel) !== undefined, `${name} literal present on both sides`);
    assert.equal(val(server), val(panel), `${name} default drifted — update both engines together`);
  }
  // Order pin: prep runs BEFORE the clock on both engines (validation/chunking
  // time uncharged by design — the line-137 comment's claim, now enforced).
  for (const [label, src] of [["server", server], ["panel", panel]]) {
    const prep = src.indexOf("= preparePassages(");
    const clock = src.indexOf("const started = ");
    assert.ok(prep >= 0 && clock > prep, `${label}: prep runs before the clock — order drifted?`);
  }
});

test("a spent budget never blocks the FIRST request", async () => {
  // budgetMs: 1 leaves remaining ~= 1 < 3 at the first measure — the gate
  // WOULD fire. Success proves the exemption lives on the first dispatch,
  // not on budget room: if a refactor moves `requests++` above the branch,
  // the first call gets gated and this goes red with the 502 instead.
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
  };
  const { results, stats } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl, budgetMs: 1 });
  assert.equal(calls, 1);
  assert.equal(stats.chunks, 1);
  assert.equal(results.length, 2);
});

test("halving with under 2 ms left throws the gate message, never a 1 ms abort", async () => {
  // Pins the gate boundary directly (`< min(timeoutMs, MIN_CALL_MS + GATE_SLACK_MS)`, 3 with default timeouts) with a scripted
  // clock — no real timing: after the exempt first pass the clock reads
  // T+48.5 of a 50 ms budget, so the 413-halve sees remaining exactly 1.5,
  // deterministically inside (1,2). (An earlier busy-spin version flaked on
  // loaded runners; the spin is gone.)
  const realNow = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      t = 48.5; // the exempt first pass burns all but 1.5 ms, by construction
      return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
    };
    const err = await searchText({ query: "fee", passages: makePassages(5) }, { config, fetchImpl, budgetMs: 50, timeoutMs: 5000 }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof SearchError && err.status === 502, "must throw a 502");
    assert.match(err.message, /whole page was swept/, "budget message - the halve retry must never start");
    assert.equal(calls, 1, "no doomed halve fetches once the budget is spent");
  } finally {
    performance.now = realNow;
  }
});

test("the gate honors small caller timeouts (min, not a flat 3)", async () => {
  // timeoutMs 2: the gate is remaining < min(2, 3) = 2. Scripted clock, two
  // runs bracketing it — 2.5 dispatches the halve retries (2 ms calls, exactly
  // what was asked), 1.5 gates. A flat-3 gate would kill the 2.5 case.
  for (const [t, dispatches] of [[47.5, true], [48.5, false]]) {
    let now = 0;
    let calls = 0;
    const realNow = performance.now.bind(performance);
    performance.now = () => now;
    const fetchImpl = async (_url, init) => {
      calls++;
      if (calls === 1) { now = t; return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 }); }
      return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
    };
    try {
      if (dispatches) {
        const out = await searchText({ query: "fee", passages: makePassages(5) }, { config, fetchImpl, timeoutMs: 2, budgetMs: 50 });
        assert.equal(calls, 3, "2.5 left with a 2 ms ceiling dispatches both halve retries");
        assert.equal(out.stats.chunks, 1, "sweep completes after the dispatched retries");
      } else {
        await assert.rejects(
          searchText({ query: "fee", passages: makePassages(5) }, { config, fetchImpl, timeoutMs: 2, budgetMs: 50 }),
          (e) => e instanceof SearchError && e.status === 502 && /whole page was swept/.test(e.message),
        );
        assert.equal(calls, 1, "1.5 left gates before any halve retry");
      }
    } finally {
      performance.now = realNow;
    }
  }
});

test("the gate edge is exact: 2.5 gates, 3.0 dispatches", async () => {
  // Brackets `< MIN_CALL_MS + 2` with a scripted clock: remaining 2.5 would
  // clamp to a 2 ms guaranteed-abort, so the gate fires (calls stays 1);
  // remaining exactly 3.0 clamps to a real 3 ms timeout and dispatches.
  const realNow = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    const gateHit = async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        t = 47.5; // halve sees remaining exactly 2.5
        return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
      };
      const err = await searchText({ query: "fee", passages: makePassages(5) }, { config, fetchImpl, budgetMs: 50 }).then(
        () => null,
        (e) => e,
      );
      return { err, calls };
    };
    const gated = await gateHit();
    assert.ok(gated.err instanceof SearchError && gated.err.status === 502, "2.5 left must throw the budget message");
    assert.equal(gated.calls, 1, "2.5 left is never dispatched");

    t = 0;
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls++;
      if (calls === 1) {
        t = 47.0; // halve sees remaining exactly 3.0
        return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
      }
      return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
    };
    const out = await searchText({ query: "fee", passages: makePassages(5) }, { config, fetchImpl, budgetMs: 50 });
    assert.equal(calls, 3, "3.0 left dispatches both halve retries");
    assert.equal(out.stats.chunks, 1, "sweep completes after the dispatched retries");
  } finally {
    performance.now = realNow;
  }
});

test("events stay consistent when the loop aborts on a later pass", async () => {
  // Throw-path pin for topDone placement: chunk 1 succeeds (event), chunk 2's
  // first attempt hits the spent budget (budgetMs: 1 — remaining <= 1 < 2
  // deterministically, elapsed can't be negative) and the search throws. The
  // emitted event must still report pass 1 of 2, and no stats escape.
  const events = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    return response({ answers: allRelevant(body), usage: {} });
  };
  const passages = makePassages(40, (i) => `Dense passage ${i}. `.repeat(125).slice(0, 2000));
  await assert.rejects(
    searchText(
      { query: "fee", passages },
      { config, fetchImpl, budgetMs: 1, onProgress: (p) => events.push({ ...p }) },
    ),
    (e) => e instanceof SearchError && e.status === 502 && /whole page was swept/.test(e.message),
  );
  assert.equal(calls, 1, "second chunk gated before any fetch");
  assert.equal(events.length, 1, "only the completed pass emitted");
  assert.equal(events[0].chunk, 1, "aborted loop still reports the finished pass, not a shifted index");
  assert.equal(events[0].chunks, 2, "denominator is the full sweep");
});

test("a 500 on the LAST chunk throws with the completed pass still reported", async () => {
  // Throw-path pin for the loop tail: chunk 1 succeeds (event), chunk 2 of 2
  // fails at the fetch (HTTP 500, not a 413 — no halve, the error propagates).
  // topDone must NOT advance past the completed pass: exactly one event, pass
  // 1 of 2, and the 500 surfaces as its own message (status 502 like every
  // transport failure — but the message names HTTP 500, not the budget 502's
  // "whole page was swept").
  const events = [];
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
    return response("boom", { ok: false, status: 500 });
  };
  const passages = makePassages(40, (i) => `Dense passage ${i}. `.repeat(125).slice(0, 2000));
  await assert.rejects(
    searchText(
      { query: "fee", passages },
      { config, fetchImpl, budgetMs: 60_000, onProgress: (p) => events.push({ ...p }) },
    ),
    (e) => e instanceof SearchError && e.status === 502 && /HTTP 500/.test(e.message),
  );
  assert.equal(calls, 2, "first chunk ok, last chunk attempted once then failed");
  assert.equal(events.length, 1, "only the completed pass emitted");
  assert.equal(events[0].chunk, 1, "failed tail does not advance the pass index");
  assert.equal(events[0].chunks, 2, "denominator is the full sweep");
});

test("searchText threads a custom maxBodyChars into chunking", async () => {
  // The preview-parity invariant rests on both sites using the same budget:
  // searchText must honor opts.maxBodyChars, not hardcode the constant.
  const passages = makePassages(20, (i) => `Threaded passage ${i}. `.repeat(75).slice(0, 1500));
  const fetchImpl = async (_url, init) => response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
  const one = await searchText({ query: "fee", passages }, { config, fetchImpl });
  assert.equal(one.stats.chunks, 1, "same input fits in one default chunk");
  const events = [];
  const many = await searchText(
    { query: "fee", passages },
    { config, fetchImpl, maxBodyChars: 20_000, onProgress: (p) => events.push({ ...p }) },
  );
  assert.ok(many.stats.chunks > 1, "custom budget splits the same input");
  assert.equal(events.length, many.stats.chunks, "one event per chunk");
  assert.ok(events.every((e) => e.chunks === many.stats.chunks), "denominator is the full sweep");
});

test("escapables tiling is exact (paired halves never match)", async () => {
  // The bullet-proof for the tiling comment in chunkPrepared: a low preceded
  // by a high is always that high\u2019s pair, so lone highs and lone lows each
  // match once and pairs never match. Written with escapes (never literal
  // surrogates in source).
  const { ESCAPABLES_RE } = await import("../search.mjs");
  const count = (s) => (s.match(ESCAPABLES_RE) ?? []).length;
  const H = "\uD800";
  const L = "\uDC00";
  assert.equal(count("a" + H + L + "b"), 0, "valid pair rides literally");
  assert.equal(count("a" + H + "b"), 1, "lone high");
  assert.equal(count("a" + L + "b"), 1, "lone low");
  assert.equal(count(H + H + L), 1, "first high lone, second pairs with the low");
});

test("lone surrogates cost +5 each in the chunk estimator", async () => {
  // Two 2000-lone-surrogate passages serialize to ~24 KB each (~48 KB wire
  // for the pair); a naive length-based packer would fit both in one 30 KB
  // chunk and blow the budget downstream. The estimator must split them.
  const lone = "\uD800".repeat(2000);
  const passages = [
    { id: "p0", text: lone },
    { id: "p1", text: lone },
  ];
  const fetchImpl = async (_url, init) => response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
  const out = await searchText({ query: "fee", passages }, { config, fetchImpl, maxBodyChars: 30_000 });
  assert.equal(out.stats.chunks, 2, "escaped cost counted, not raw length");
});

test("sub-pass retries share their parent index when a later chunk aborts", async () => {
  // topDone behavior under a mid-sweep throw with REAL sub-passes: chunk 1
  // succeeds, chunk 2's first try 413s, both halves succeed (same pass index),
  // then chunk 3 hits the spent budget. A scripted clock drives the gate
  // deterministically — no real timing involved.
  const realNow = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls++;
      t = calls * 10; // 10 ms per dispatch, by construction
      if (calls === 2) return response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
      return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
    };
    const events = [];
    const passages = makePassages(64, (i) => `Dense passage ${i}. `.repeat(125).slice(0, 2000));
    const err = await searchText(
      { query: "fee", passages },
      { config, fetchImpl, budgetMs: 41, onProgress: (p) => events.push({ ...p }) },
    ).then(() => null, (e) => e);
    assert.ok(err instanceof SearchError && err.status === 502, "must throw a 502");
    assert.match(err.message, /whole page was swept/, "budget message, not an abort");
    assert.equal(calls, 4, "chunk1 + chunk2 attempt + two halves; chunk3 gated before any fetch");
    const idx = events.map((e) => [e.chunk, e.chunks]);
    const n = events[0].chunks;
    assert.equal(n, 3, "fixture splits exactly 3 ways (24,24,16) — re-derive if the estimator changes");
    assert.deepEqual(idx, [[1, n], [2, n], [2, n]], "halve retries report the parent pass, never N > M");
  } finally {
    performance.now = realNow;
  }
});



test("one measure per attempt is observable in the reported ms (advancing clock)", async () => {
  // Behavioral form of "no stale measure": the scripted clock advances 1 ms
  // per READ, so the clock-read count is visible in the reported ms output.
  // One chunk, one attempt, success: started(1000), measure(1001),
  // final(1002) — exactly 3 reads and ms === 2. A second measure (or any new
  // clock read in buildRequest/askJev) shifts BOTH pins: reads 4, ms 3. The ms
  // assert is pure black-box behavior — no structural caveats needed.
  const realNow = performance.now.bind(performance);
  let now = 1000;
  let reads = 0;
  performance.now = () => { reads++; return now++; };
  try {
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls++;
      return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
    };
    const { results, stats } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl, budgetMs: 60_000 });
    assert.equal(calls, 1);
    assert.equal(results.length, 2);
    assert.equal(reads, 3, "started + one measure + final ms, nothing else reads the clock");
    assert.equal(stats.ms, 2, "ms reflects exactly 3 clock reads — a re-read would report 3");
  } finally {
    performance.now = realNow;
  }
});

test("searchText: a single passage too big on its own is an honest 413, not a fake 502", async () => {
  const fetchImpl = async () => response({ detail: { error_type: "max_tokens_exceeded" } }, { ok: false, status: 400 });
  await assert.rejects(
    () => searchText({ query: "q", passages: makePassages(1, () => "one dense passage. ".repeat(50)) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 413 && /too big for the model on its own/.test(e.message),
  );
});

test("searchText: another 400 keeps its own words and says which kind it was", async () => {
  const fetchImpl = async () => response({ detail: { error_type: "bad_request_body" } }, { ok: false, status: 400 });
  await assert.rejects(
    () => searchText({ query: "q", passages: makePassages(1) }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 502 && /HTTP 400 \(bad_request_body\)/.test(e.message),
  );
});

test("budgetMs must be a positive number", async () => {
  const fetchImpl = async () => response({ answers: {}, usage: {} });
  for (const bad of [0, -5, NaN, "x", Infinity]) {
    await assert.rejects(
      () => searchText({ query: "q", passages: makePassages(1) }, { config, fetchImpl, budgetMs: bad }),
      (e) => e instanceof SearchError && e.status === 500 && /budgetMs must be a positive number/.test(e.message),
    );
  }
});

test("an exhausted whole-search budget stops later passes with a 502", async () => {
  let calls = 0;
  let firstAborted = false;
  const fetchImpl = async (url, init) => {
    calls++;
    // Honors the signal: if the first call were budget-clamped to ~20 ms, this
    // abort would fire and the pass would fail. It must NOT fire — the first
    // pass runs with the caller's full timeout.
    await new Promise((res, rej) => {
      const t = setTimeout(res, 100); // the first pass alone spends the 20 ms budget
      init.signal?.addEventListener("abort", () => {
        firstAborted = true;
        clearTimeout(t);
        rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
    return response({ answers: allRelevant(JSON.parse(init.body)), usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const err = await searchText({ query: "fee", passages: makePassages(BATCH_MAX + 5) }, { config, fetchImpl, budgetMs: 20 }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "must throw once the budget is spent");
  assert.ok(err instanceof SearchError && err.status === 502);
  assert.match(err.message, /whole page was swept/);
  assert.equal(calls, 1, "the first pass always runs; the second never starts");
  assert.equal(firstAborted, false, "the first pass must not be budget-aborted");
});

test("the first pass is exempt from the budget clamp", async () => {
  // 2 chunks, budgetMs: 1 — the budget is already spent before the first call.
  // The first chunk must still succeed (caller's full timeout); the second is gated.
  // AbortSignal.timeout fires only on a live loop (production always has one);
  // without this the idle test loop would drain and the abort would never fire.
  const keepAlive = setInterval(() => {}, 100);
  try {
    let calls = 0;
    const fetchImpl = async (url, init) =>
      new Promise((res, rej) => {
        calls++;
        const t = setTimeout(
          () => res(response({ answers: allRelevant(JSON.parse(init.body)), usage: { input_tokens: 1, output_tokens: 1 } })),
          50,
        );
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const err = await searchText(
      { query: "fee", passages: makePassages(BATCH_MAX + 5) },
      { config, fetchImpl, budgetMs: 1, timeoutMs: 5000 },
    ).then(
      () => null,
      (e) => e,
    );
    // The budget-gate message, not the call-timeout one: proves the first chunk
    // RAN (50 ms of work inside a 1 ms budget) and the SECOND pass was gated.
    assert.ok(err instanceof SearchError && err.status === 502, "must throw a 502");
    assert.match(err.message, /whole page was swept/, "gate message = first chunk succeeded, second blocked");
    assert.equal(calls, 1, "first chunk succeeded despite the spent budget; second never started");
  } finally {
    clearInterval(keepAlive);
  }
});

test("clampCallTimeout honors the caller and bounds the remainder", () => {
  assert.equal(clampCallTimeout(20_000, 30_000), 20_000); // budget to spare: caller wins
  assert.equal(clampCallTimeout(20_000, 500), 500); // late call: remainder wins
  assert.equal(clampCallTimeout(500, 39_000), 500); // sub-second caller timeout is never rounded up
  assert.equal(clampCallTimeout(20_000, 0), 1); // nothing left: fail fast, never unbounded
  assert.equal(clampCallTimeout(20_000, -100), 1);
  assert.equal(clampCallTimeout(20_000, 19.26), 19); // fractional remainders are floored: AbortSignal.timeout needs an integer
  assert.equal(clampCallTimeout(0.5, 100), 1); // fractional caller timeouts cannot produce a 0 ms signal
  assert.equal(clampCallTimeout(20_000, Infinity), 20_000); // first-pass sentinel: no budget bound, caller wins floored
  assert.equal(clampCallTimeout(19.26, Infinity), 19);
  assert.equal(clampCallTimeout(2, 3.0), 2); // the gate promises >= min(3, timeoutMs), not >= 3: a 2 ms caller timeout still yields 2
  assert.equal(clampCallTimeout(2, 100), 2); // caller ceiling respected even with budget to spare
  // Property, not points: past the gate (remaining >= min(t, 3)) the clamp never
  // shaves more than the integer-floor below min(3, t) — clamp(t, r) >=
  // floor(min(3, t)) in every regime, including the gate-adjacent edge the
  // point samples skip (r = min(t, 3) exactly and +0.01 above it, per t:
  // fractional caller timeouts lose <1 ms to the floor; the budget side
  // contributes no further shrinkage).
  for (const t of [0.5, 1, 2, 2.5, 2.99, 3, 3.5, 19.26, 20_000]) {
    for (const r of [Math.min(t, 3), Math.min(t, 3) + 0.01, 3, 3.01, 10, 100, Infinity]) {
      assert.ok(clampCallTimeout(t, r) >= Math.floor(Math.min(3, t)), `clamp(${t}, ${r}) >= floor(min(3, ${t}))`);
      // Upper edge: the 1 ms floor can round UP past a sub-1 ms caller timeout
      // (clamp(0.5, r) = 1 — never down to a 0 ms abort, never a RangeError),
      // but never past ceil(t) otherwise: max(1, floor(min(t,r))) <= max(1, ceil(t)).
      assert.ok(clampCallTimeout(t, r) <= Math.max(1, Math.ceil(t)), `clamp(${t}, ${r}) <= max(1, ceil(${t}))`);
    }
  }
});

test("timeoutMs: Infinity is rejected, not clamped", async () => {
  // The clamp's Infinity sentinel is for REMAINING only (first pass); a caller
  // timeoutMs: Infinity is a validation error 500 — pinned here so the JSDoc's
  // "both caller options stay finite" holds for both, not just budgetMs.
  await assert.rejects(
    searchText({ query: "fee", passages: makePassages(2) }, { config, timeoutMs: Infinity }),
    (e) => e instanceof SearchError && e.status === 500 && /timeoutMs must be a positive number/.test(e.message),
  );
});

test("fractional caller timeout is floored before dispatch, never RangeErrors", async () => {
  // AbortSignal.timeout throws on fractions — the first-pass clamp floors the
  // caller timeout before the signal is built (line: clamp(t, Inf)). Without
  // the floor, timeoutMs 500.7 dies as a RangeError instead of dispatching.
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    return response({ answers: allRelevant(JSON.parse(init.body)), usage: {} });
  };
  const { results } = await searchText({ query: "fee", passages: makePassages(2) }, { config, fetchImpl, timeoutMs: 500.7, budgetMs: 60_000 });
  assert.equal(calls, 1);
  assert.equal(results.length, 2);
});

test("a sub-second timeoutMs fails fast instead of rounding up to 1 s", { timeout: 10_000 }, async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  // AbortSignal.timeout fires only on a live loop (production always has one:
  // server sockets, open ports); without this the idle test loop would drain.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => searchText({ query: "q", passages: makePassages(1) }, { config, fetchImpl, timeoutMs: 500, budgetMs: 60_000 }),
      (e) => e instanceof SearchError && e.status === 502 && /took too long/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 1500, "a 500 ms timeout must not behave like a 1000 ms one");
  } finally {
    clearInterval(keepAlive);
  }
});
