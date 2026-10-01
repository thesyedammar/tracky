// Validation specs — the no-fabrication gate. Names describe the behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { validateSearchInput, parseJevAnswers, rankResults, SearchError, LIMITS } from "../validate.mjs";
import { preparePassages } from "../jev.mjs";

const prepared = preparePassages([
  { id: "p0", text: "A service charge of Rs.250 applies. The sky is blue." },
  { id: "p1", text: "The pool is warm." },
]);

const goodAnswers = {
  answers: {
    p0: { type: "noul", noul: 0.9 },
    focus_p0: { type: "choice", choice: "s0", confidence: 1, probabilities: { s0: 1, s1: 0 } },
    p1: { type: "noul", noul: 0.1 },
  },
};

// ---------- input validation ----------

test("accepts a valid input and normalizes it", () => {
  const out = validateSearchInput({ query: "  hidden charges  ", passages: [{ id: "p0", text: "Fee applies." }] });
  assert.equal(out.query, "hidden charges");
  assert.deepEqual(out.passages, [{ id: "p0", text: "Fee applies." }]);
});

test("rejects an empty query", () => {
  assert.throws(() => validateSearchInput({ query: "   ", passages: [{ id: "p0", text: "x" }] }), SearchError);
});

test("rejects an oversized query", () => {
  assert.throws(() => validateSearchInput({ query: "x".repeat(LIMITS.queryMax + 1), passages: [{ id: "p0", text: "x" }] }), SearchError);
});

test("rejects zero passages and non-array passages", () => {
  assert.throws(() => validateSearchInput({ query: "q", passages: [] }), SearchError);
  assert.throws(() => validateSearchInput({ query: "q", passages: "nope" }), SearchError);
});

test("rejects duplicated passage ids", () => {
  assert.throws(
    () => validateSearchInput({ query: "q", passages: [{ id: "p0", text: "a" }, { id: "p0", text: "b" }] }),
    SearchError,
  );
});

test("rejects over-long passage ids (wire-overhead bound)", () => {
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "p00", text: "x" }] }), SearchError);
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "p" + "1".repeat(30), text: "x" }] }), SearchError);
});

test("pins the id-length boundary: p99999 valid, p100000 invalid", () => {
  const ok = validateSearchInput({ query: "q", passages: [{ id: "p99999", text: "x" }] });
  assert.equal(ok.passages[0].id, "p99999");
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "p100000", text: "x" }] }), SearchError);
  // Non-ASCII ids are rejected: ID_RE pins the p-number id shape.
  // (Bound soundness no longer depends on this — idChars accumulates exact
  // bytes — but the format is still guarded: a loosened ID_RE goes red here.)
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "pé", text: "x" }] }), SearchError);
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "p١٢٣", text: "x" }] }), SearchError);
  assert.equal(Buffer.byteLength("p99999"), "p99999".length, "longest legal id is pure ASCII");
});

test("rejects a malformed passage id", () => {
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "b0", text: "a" }] }), SearchError);
});

test("rejects an oversized passage", () => {
  assert.throws(
    () => validateSearchInput({ query: "q", passages: [{ id: "p0", text: "x".repeat(LIMITS.passageMax + 1) }] }),
    SearchError,
  );
});

test("CJK text fails with a clear 400, never a downstream 413", () => {
  // 400k chars under the char cap but ~1.2 MB on the wire: bytes, not chars,
  // are what the transport cap counts.
  const cjk = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, text: `手数料${i} `.padEnd(2000, "あ") }));
  assert.equal(cjk.reduce((n, p) => n + p.text.length, 0), 400000);
  assert.throws(
    () => validateSearchInput({ query: "q", passages: cjk }),
    (e) => e instanceof SearchError && e.status === 400 && /once encoded/.test(e.message),
  );
});

test("trigger equality passes: bound exactly on the cap skips measuring safely", () => {
  // The fast-path TRIGGER (`>` skips when bound <= cap) at exact equality:
  // 6*total + idChars + 21*n + slack == totalBytesMax must pass (skip), and
  // total+1 must also pass (over-trigger only pays one stringify — the trigger
  // never throws). Derived from LIMITS: n=34 with 6 two-char + 28 three-char
  // ids (idChars=96, 96 = 0 mod 6) makes total integral; widths fit passageMax.
  const slack = LIMITS.queryMax * 6 + 100;
  const ids = ["p0", "p1", "p2", "p3", "p4", "p5", ...Array.from({ length: 28 }, (_, i) => `p${10 + i}`)];
  const n = ids.length;
  const idChars = ids.reduce((a, id) => a + id.length, 0);
  assert.equal(n, 34);
  assert.equal(idChars, 96);
  const total = (LIMITS.totalBytesMax - slack - idChars - 21 * n) / 6;
  assert.ok(Number.isInteger(total), "fixture lands exactly on the cap");
  const q = Math.floor(total / n);
  const widths = Array.from({ length: n }, (_, i) => q + (i < total % n ? 1 : 0));
  assert.ok(widths.every((w) => w <= LIMITS.passageMax), "fixture infeasible: widths exceed passageMax");
  const mk = (t) => ids.map((id, i) => ({ id, text: "x".repeat(widths[i] + (i === 0 ? t : 0)) }));
  assert.equal(validateSearchInput({ query: "q", passages: mk(0) }).passages.length, n);
  assert.equal(validateSearchInput({ query: "q", passages: mk(1) }).passages.length, n);
});

test("true-cap equality passes, cap+1 throws (the > is exact)", () => {
  // The TRUE CAP (stringify comparison) at exact equality: serialized wire of
  // exactly totalBytesMax passes; one byte more throws 400. n=182 derived from
  // LIMITS (idChars recomputed from the real ids, so digit-width drift cannot
  // silently move the edge); widths fit passageMax or the test says so loudly.
  const n = 182;
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const idChars = ids.reduce((a, id) => a + id.length, 0);
  const T = LIMITS.totalBytesMax - idChars - 19 * n - (n + 1); // brackets 2 + commas n-1
  assert.ok(T > 0, "cap too small for an exact-equality fixture at n=182");
  const q = Math.floor(T / n);
  const r = T % n;
  const widths = Array.from({ length: n }, (_, i) => q + (i < r ? 1 : 0));
  assert.ok(widths.every((w) => w <= LIMITS.passageMax), "fixture infeasible: widths exceed passageMax");
  assert.ok(widths[0] + 1 <= LIMITS.passageMax, "plus-one variant must stay a byte-cap question, not a passageMax one");
  const mk = (bump) => ids.map((id, i) => ({ id, text: "x".repeat(widths[i] + (i === 0 && bump ? 1 : 0)) }));
  assert.equal(validateSearchInput({ query: "q", passages: mk(false) }).passages.length, n);
  assert.throws(() => validateSearchInput({ query: "q", passages: mk(true) }), (e) => e.status === 400);
});

test("wire scaffolding constants are pinned (fast-path bound depends on them)", () => {
  // DERIVATION (the bound's only full copy — validate.mjs points here):
  // text units cost at most 6 B each (U+XXXX escapes and lone surrogates; CJK
  // rides at 3, astral pairs at 2/unit); ids cost exact bytes via
  // Buffer.byteLength into idChars — no charset coupling by construction;
  // scaffolding (19 B fixed + array share 1 + 1/n for brackets + commas) is
  // covered by 21/passage: EXACT at n=1, 1 to spare at n=2, ~n-1 at scale;
  // the query (<=LIMITS.queryMax chars, <=2400 B at 6 B/char) and envelope
  // (~100 B) ride in LIMITS.queryMax * 6 + 100 — derived from the limit, so a
  // queryMax bump flows through the formula. Wire <= 6*total + idChars + 21*n
  // + slack. The slack provably covers the worst query on the wire:
  assert.ok(
    Buffer.byteLength(JSON.stringify(String.fromCharCode(0xd800).repeat(LIMITS.queryMax))) <= LIMITS.queryMax * 6 + 100,
    "slack covers the worst-case all-lone-surrogate query plus quotes on the wire",
  );
  // If serialization ever changes shape, this goes red before the bound goes
  // unsound.
  // COINCIDENCE WARNING: 21 appears twice with different 2s — the p0 asserts
  // below are 19 scaffold + 2 id chars, while the bound's 21 is 19 + 2 array
  // share. Both decompositions are pinned here (brackets/comma asserts for
  // the share, additive-id assert for ids); do not derive one 21 from the
  // other.
  assert.equal(Buffer.byteLength(JSON.stringify({ id: "", text: "" })), 19, "fixed scaffolding per passage object");
  assert.equal(Buffer.byteLength(JSON.stringify({ id: "p0", text: "" })), 21, "per-object total: 19 fixed + 2 id chars (the id LENGTH, not the array share)");
  assert.equal(Buffer.byteLength(JSON.stringify({ id: "p99999", text: "" })), 25, "per-object total: 19 fixed + 6 id chars (length, not share)");
  assert.equal(
    Buffer.byteLength(JSON.stringify({ id: "p0", text: "" })),
    Buffer.byteLength(JSON.stringify({ id: "", text: "" })) + "p0".length,
    "id bytes decompose additively — the bound's separate idChars term rests on this; if red, re-derive the 21 in validate.mjs",
  );
  const one = JSON.stringify({ id: "p0", text: "x" });
  assert.equal(Buffer.byteLength(JSON.stringify([JSON.parse(one)])), Buffer.byteLength(one) + 2, "array of one adds brackets only");
  const two = [JSON.parse(one), JSON.parse(one)];
  assert.equal(
    Buffer.byteLength(JSON.stringify(two)),
    2 * Buffer.byteLength(one) + 3,
    "array of two adds brackets + one comma",
  );
});

test("mid-size multibyte text still measures (fast-path threshold is exact)", () => {
  // 150k CJK chars ≈ 450 KB wire: total*2 (300k) would SKIP measuring and pass
  // wrongly; total*6 (900k) forces the stringify, which throws. Pins the ×6.
  const cjk = Array.from({ length: 75 }, (_, i) => ({ id: `p${i}`, text: `手数料${i} `.padEnd(2000, "あ") }));
  assert.equal(cjk.reduce((n, p) => n + p.text.length, 0), 150000);
  assert.ok(Buffer.byteLength(JSON.stringify(cjk.map((p) => ({ id: p.id, text: p.text })))) > 400_000, "fixture must exceed the byte cap on the wire");
  assert.throws(
    () => validateSearchInput({ query: "q", passages: cjk }),
    (e) => e instanceof SearchError && e.status === 400 && /once encoded/.test(e.message),
  );
});

test("lone-surrogate-heavy input still measures (×4 would skip it)", () => {
  // 80k lone surrogates: each serializes to 6 bytes (~480 KB wire) but only 1
  // char. total*4 (320k) would SKIP and pass a 480 KB body to the transport's
  // 413; total*6 (480k) forces the measure, which throws here instead.
  const lone = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, text: "x".repeat(100) + "\ud800".repeat(1900) }));
  assert.equal(lone.reduce((n, p) => n + p.text.length, 0), 80000);
  assert.ok(Buffer.byteLength(JSON.stringify(lone.map((p) => ({ id: p.id, text: p.text })))) > 400_000, "fixture must exceed the byte cap on the wire");
  assert.throws(
    () => validateSearchInput({ query: "q", passages: lone }),
    (e) => e instanceof SearchError && e.status === 400 && /once encoded/.test(e.message),
  );
});

test("English text under the byte cap still passes validation", () => {
  const eng = Array.from({ length: 197 }, (_, i) => ({ id: `p${i}`, text: `fee ${i} `.padEnd(2000, "x") }));
  const bytes = eng.reduce((n, p) => n + Buffer.byteLength(JSON.stringify({ id: p.id, text: p.text })), 0);
  assert.ok(bytes < 400_000, `fixture must fit the cap (got ${bytes})`);
  assert.equal(validateSearchInput({ query: "q", passages: eng }).passages.length, 197);
});

test("quote-heavy text fails on serialized bytes, not raw length", () => {
  // 400,000 raw bytes but ~800 KB once JSON-escaped: the old raw-byte check
  // passed this straight into a downstream 413.
  const quotes = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, text: `"q${i}" `.padEnd(2000, '"') }));
  assert.ok(quotes.reduce((n, p) => n + Buffer.byteLength(p.text), 0) <= 400_000, "raw bytes fit the cap");
  assert.throws(
    () => validateSearchInput({ query: "q", passages: quotes }),
    (e) => e instanceof SearchError && e.status === 400 && /once encoded/.test(e.message),
  );
});

// ---------- answer adjudication ----------

test("accepts a valid answer set", () => {
  const parsed = parseJevAnswers(goodAnswers, prepared);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].score, 0.9);
  assert.equal(parsed[0].focusText, "A service charge of Rs.250 applies.");
  assert.equal(parsed[0].focusStart, 0);
  assert.equal(parsed[1].focusText, "The pool is warm."); // single sentence → implied s0
  assert.equal(parsed[1].focusStart, 0);
});

test("focusStart is the exact offset of the chosen sentence", () => {
  const answers = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s1" }, p1: { noul: 0.1 } } };
  const parsed = parseJevAnswers(answers, prepared);
  const s1 = prepared[0].sentences[1];
  assert.equal(parsed[0].focusStart, s1.start);
  assert.equal(prepared[0].text.slice(parsed[0].focusStart, parsed[0].focusStart + s1.text.length), s1.text);
});

test("rejects a score above 1", () => {
  const bad = { answers: { p0: { noul: 1.2 }, focus_p0: { choice: "s0" }, p1: { noul: 0.1 } } };
  assert.throws(() => parseJevAnswers(bad, prepared), (e) => e instanceof SearchError && e.status === 502);
});

test("rejects a negative or non-numeric score", () => {
  for (const v of [-0.1, "0.5", null]) {
    const bad = { answers: { p0: { noul: v }, focus_p0: { choice: "s0" }, p1: { noul: 0.1 } } };
    assert.throws(() => parseJevAnswers(bad, prepared), SearchError);
  }
});

test("rejects an unknown sentence id", () => {
  const bad = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s9" }, p1: { noul: 0.1 } } };
  assert.throws(() => parseJevAnswers(bad, prepared), (e) => e instanceof SearchError && e.status === 502);
});

test("rejects a malformed choice label (s01)", () => {
  const bad = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s01" }, p1: { noul: 0.1 } } };
  assert.throws(() => parseJevAnswers(bad, prepared), SearchError);
});

test("missing answers object is an upstream failure", () => {
  assert.throws(() => parseJevAnswers({}, prepared), (e) => e instanceof SearchError && e.status === 502);
});

test("missing per-passage answer is an upstream failure", () => {
  const bad = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s0" } } }; // p1 absent
  assert.throws(() => parseJevAnswers(bad, prepared), (e) => e instanceof SearchError && e.status === 502);
});

// ---------- ranking ----------

test("rankResults validates its overrides", () => {
  const parsed = [{ id: "p0", score: 0.9, focusText: "a" }];
  for (const bad of [{ minBest: NaN }, { minBest: 2 }, { minBest: -1 }, { ofBest: 0 }, { ofBest: -1 }, { limit: 0 }, { limit: 9 }, { limit: 2.5 }]) {
    assert.throws(() => rankResults(parsed, bad), SearchError);
  }
  assert.equal(rankResults(parsed, { minBest: 0, ofBest: 1, limit: 8 }).length, 1); // the boundaries are fine
});

test("rankResults: nothing good enough → honest empty", () => {
  const weak = [
    { id: "p0", score: 0.52, focusText: "a" },
    { id: "p1", score: 0.31, focusText: "b" },
  ];
  assert.deepEqual(rankResults(weak), []); // best 0.52 < the 0.58 gate
});

test("rankResults: stragglers far below the best never surface (live pet-query case)", () => {
  const mixed = [
    { id: "p0", score: 0.64, focusText: "The cleaning charge covers pet hair." },
    { id: "p1", score: 0.09, focusText: "Every vehicle is photographed." },
    { id: "p2", score: 0.03, focusText: "Unlimited kilometres for personal use." },
  ];
  assert.deepEqual(rankResults(mixed).map((r) => r.passageId), ["p0"]); // band 0.352 drops the 0.09/0.03 stragglers
});

test("rankResults: extends with items within 45% of best, capped at 8", () => {
  const items = [0.95, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4].map((s, i) => ({
    id: `p${i}`,
    score: s,
    focusText: `s${i}`,
  }));
  // best 0.95 → band 0.5225 → 0.55 and up kept (7 items; the 0.5 falls below the band)
  assert.equal(rankResults(items).length, 7);

  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, score: 0.9 - i * 0.01, focusText: `s${i}` }));
  assert.equal(rankResults(twelve).length, 8); // band 0.495 → all 12 qualify, the cap bites
});

test("never fabricates: every result sentence is an exact substring of its passage", () => {
  const parsed = parseJevAnswers(goodAnswers, prepared);
  for (const r of rankResults(parsed, { minBest: 0 })) {
    const source = prepared.find((p) => p.id === r.passageId);
    assert.ok(source.text.includes(r.sentence), `"${r.sentence}" not in passage ${r.passageId}`);
  }
});

test("results without a sentence never surface", () => {
  const parsed = [{ id: "p0", score: 0.99, focusText: null }];
  assert.deepEqual(rankResults(parsed), []);
});

test("rejects leading-zero passage ids (p00)", () => {
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "p00", text: "a" }] }), SearchError);
});

test("passage-count safety cap: 1200 ok, 1201 rejected", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: "x" }));
  assert.equal(validateSearchInput({ query: "q", passages: many(1200) }).passages.length, 1200);
  assert.throws(() => validateSearchInput({ query: "q", passages: many(1201) }), SearchError);
});

test("malformed probabilities are dropped, not fatal", () => {
  const messy = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s0", probabilities: { s0: "high" } }, p1: { noul: 0.1 } } };
  const parsed = parseJevAnswers(messy, prepared);
  assert.equal(parsed[0].choiceProbabilities, null);
  assert.equal(parsed[0].focusText, "A service charge of Rs.250 applies.");

  const arrayProbs = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s0", probabilities: [0.9, 0.1] }, p1: { noul: 0.1 } } };
  assert.equal(parseJevAnswers(arrayProbs, prepared)[0].choiceProbabilities, null);
});
