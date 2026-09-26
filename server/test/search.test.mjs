// Engine specs — chunking, merging, dedupe, progress, and every failure mode.
import test from "node:test";
import assert from "node:assert/strict";
import { searchText, dedupeResults } from "../search.mjs";
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
