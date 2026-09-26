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

test("rejects a malformed passage id", () => {
  assert.throws(() => validateSearchInput({ query: "q", passages: [{ id: "b0", text: "a" }] }), SearchError);
});

test("rejects an oversized passage", () => {
  assert.throws(
    () => validateSearchInput({ query: "q", passages: [{ id: "p0", text: "x".repeat(LIMITS.passageMax + 1) }] }),
    SearchError,
  );
});

// ---------- answer adjudication ----------

test("accepts a valid answer set", () => {
  const parsed = parseJevAnswers(goodAnswers, prepared);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].score, 0.9);
  assert.equal(parsed[0].focusText, "A service charge of Rs.250 applies.");
  assert.equal(parsed[1].focusText, "The pool is warm."); // single sentence → implied s0
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

test("rankResults: nothing good enough → honest empty", () => {
  const weak = [
    { id: "p0", score: 0.52, focusText: "a" },
    { id: "p1", score: 0.31, focusText: "b" },
  ];
  assert.deepEqual(rankResults(weak), []); // best 0.52 < the 0.58 gate
});

test("rankResults: top 3 always shown once the best clears the gate", () => {
  const mixed = [
    { id: "p0", score: 0.9, focusText: "a" },
    { id: "p1", score: 0.2, focusText: "b" },
    { id: "p2", score: 0.1, focusText: "c" },
    { id: "p3", score: 0.05, focusText: "d" },
  ];
  assert.deepEqual(rankResults(mixed).map((r) => r.passageId), ["p0", "p1", "p2"]);
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

test("malformed probabilities are dropped, not fatal", () => {
  const messy = { answers: { p0: { noul: 0.9 }, focus_p0: { choice: "s0", probabilities: { s0: "high" } }, p1: { noul: 0.1 } } };
  const parsed = parseJevAnswers(messy, prepared);
  assert.equal(parsed[0].choiceProbabilities, null);
  assert.equal(parsed[0].focusText, "A service charge of Rs.250 applies.");
});
