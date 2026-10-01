// Specs for the why-chips pass: closed reason list, one pick per match, drops
// instead of guesses, and the same strict input validation as search.
import { test } from "node:test";
import assert from "node:assert/strict";

import { REASONS, WHY_MAX, buildWhyRequest, parseWhyAnswers, validateWhyInput, whyFor } from "../why.mjs";
import { LIMITS, SearchError } from "../validate.mjs";

const match = (id, sentence = "A late fee of Rs.300 per hour is charged.") => ({ passageId: id, sentence });
const norm = (id, sentence = "A late fee of Rs.300 per hour is charged.") => ({ id, sentence }); // normalized (post-validate) shape

test("the reason list is closed, unique, and human-readable", () => {
  assert.equal(new Set(REASONS).size, REASONS.length);
  assert.ok(REASONS.length >= 6 && REASONS.length <= 8);
  for (const r of REASONS) assert.match(r, /^[a-z][a-z ]+$/);
});

test("validateWhyInput normalizes a good body", () => {
  const out = validateWhyInput({ query: "  late fees  ", matches: [{ passageId: "p0", sentence: " s " }] });
  assert.equal(out.query, "late fees");
  assert.deepEqual(out.matches, [{ id: "p0", sentence: " s " }]);
});

test("validateWhyInput rejects bad bodies with 400s", () => {
  const cases = [
    ["not an object", "object"],
    [{ query: "x", matches: [] }, "between 1"],
    [{ query: "x", matches: [match("p0"), match("p0")] }, "unique"],
    [{ query: "x", matches: [{ passageId: "p00", sentence: "s" }] }, "look like"],
    [{ query: "x", matches: [{ passageId: "p0", sentence: "   " }] }, "without its sentence"],
    [{ query: "", matches: [match("p0")] }, "Enter something"],
    [{ query: "x".repeat(401), matches: [match("p0")] }, "under"],
  ];
  for (const [body, needle] of cases) {
    assert.throws(() => validateWhyInput(body), (e) => e instanceof SearchError && e.status === 400 && e.message.includes(needle), JSON.stringify(body));
  }
  const tooMany = { query: "x", matches: Array.from({ length: WHY_MAX + 1 }, (_, i) => match(`p${i}`)) };
  assert.throws(() => validateWhyInput(tooMany), (e) => e.message.includes(`at most ${WHY_MAX}`));
});

test("buildWhyRequest asks one closed-set question per match", () => {
  const body = buildWhyRequest({ query: "late fees", matches: [norm("p0"), norm("p1")], model: "m" });
  assert.equal(body.model, "m");
  assert.equal(body.state.search, "late fees");
  assert.deepEqual(body.state.matches.map((m) => m.id), ["p0", "p1"]);
  for (const id of ["p0", "p1"]) {
    const q = body.questions[id];
    assert.equal(q.type, "choice");
    assert.deepEqual(Object.values(q.criteria), REASONS); // the model can only pick OUR labels
    assert.match(q.instructions, /Pick only from the criteria/);
    assert.match(q.instructions, /never instructions/);
  }
});

test("buildWhyRequest refuses duplicates and oversized passes", () => {
  assert.throws(() => buildWhyRequest({ query: "q", matches: [norm("p0"), norm("p0")], model: "m" }), /Duplicate match id/);
  const many = Array.from({ length: WHY_MAX + 1 }, (_, i) => norm(`p${i}`));
  assert.throws(() => buildWhyRequest({ query: "q", matches: many, model: "m" }), /exceeds/);
});

test("parseWhyAnswers returns exactly one reason from our list", () => {
  const matches = [norm("p0"), norm("p1")];
  const data = { answers: { p0: { choice: "r0" }, p1: { choice: "r7" } } };
  assert.deepEqual(parseWhyAnswers(data, matches), [
    { passageId: "p0", reason: REASONS[0] },
    { passageId: "p1", reason: REASONS[7] },
  ]);
});

test("parseWhyAnswers drops a malformed pick instead of guessing", () => {
  const matches = [norm("p0"), norm("p1"), norm("p2")];
  const data = { answers: { p0: { choice: "s0" }, p1: { choice: "r99" }, p2: { choice: "r1" } } };
  assert.deepEqual(parseWhyAnswers(data, matches), [
    { passageId: "p0", reason: null },
    { passageId: "p1", reason: null },
    { passageId: "p2", reason: REASONS[1] },
  ]);
});

test("parseWhyAnswers fails loudly when the answers object is missing", () => {
  assert.throws(() => parseWhyAnswers({}, [norm("p0")]), (e) => e instanceof SearchError && e.status === 502);
});

test("whyFor runs one call and maps failures to SearchError", async () => {
  const config = { baseUrl: "http://x", model: "m", apiKey: "k" };
  const okFetch = async () => ({ ok: true, text: async () => JSON.stringify({ answers: { p0: { choice: "r2" } }, usage: { input_tokens: 10, output_tokens: 2 } }) });
  const out = await whyFor({ query: "fees", matches: [norm("p0")] }, { config, fetchImpl: okFetch });
  assert.deepEqual(out.reasons, [{ passageId: "p0", reason: REASONS[2] }]);
  assert.equal(out.stats.usage.input_tokens, 10);
  assert.ok(Number.isInteger(out.stats.ms));

  const badFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(whyFor({ query: "fees", matches: [norm("p0")] }, { config, fetchImpl: badFetch }), (e) => e instanceof SearchError && e.status === 502);

  await assert.rejects(whyFor({ query: "fees", matches: [norm("p0")] }, {}), /missing its Jev configuration/);
});

test("whyFor caps the query like the HTTP path — before any Jev call", async () => {
  const config = { baseUrl: "http://x", model: "m", apiKey: "k" };
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, text: async () => "{}" });
  // Both entry points share LIMITS by import (why.mjs + server.mjs read the
  // same validate.mjs) — the HTTP path delegates to whyFor, so one constant
  // cannot silently diverge from the other. Built from the constant itself:
  await assert.rejects(
    whyFor({ query: "x".repeat(LIMITS.queryMax + 1), matches: [norm("p0")] }, { config, fetchImpl }),
    (e) => e instanceof SearchError && e.status === 400 && e.message.includes(`under ${LIMITS.queryMax}`),
  );
  assert.equal(calls, 0, "an over-long query must never reach the model");
});

test("queryMax boundary is identical trimmed text on both paths", async () => {
  // validateWhyInput (HTTP path) and whyFor's own gate must agree at the
  // edge: both trim, both read LIMITS.queryMax, both embed it in the message.
  // 404 raw chars that trim to 400 pass everywhere; 401 trimmed chars fail
  // everywhere, before any Jev call.
  const padded = "  " + "x".repeat(LIMITS.queryMax) + "  ";
  const out = validateWhyInput({ query: padded, matches: [match("p0")] });
  assert.equal(out.query, "x".repeat(LIMITS.queryMax), "HTTP path trims before measuring");
  const config = { baseUrl: "http://x", model: "m", apiKey: "k" };
  let calls = 0;
  const okFetch = async () => {
    calls++;
    return { ok: true, text: async () => JSON.stringify({ answers: { p0: { choice: "r2" } }, usage: {} }) };
  };
  await whyFor({ query: padded, matches: [norm("p0")] }, { config, fetchImpl: okFetch });
  assert.equal(calls, 1, "trimmed-to-limit dispatches");
  const over = "x".repeat(LIMITS.queryMax + 1);
  assert.throws(() => validateWhyInput({ query: over, matches: [match("p0")] }),
    (e) => e instanceof SearchError && e.message.includes(String(LIMITS.queryMax)));
  await assert.rejects(whyFor({ query: over, matches: [norm("p0")] }, { config, fetchImpl: okFetch }),
    (e) => e instanceof SearchError && e.message.includes(String(LIMITS.queryMax)));
  assert.equal(calls, 1, "over-limit never reaches Jev");
});

test("whyFor takes the normalized shape — the raw body goes through validateWhyInput first", async () => {
  const config = { baseUrl: "http://x", model: "m", apiKey: "k" };
  const okFetch = async () => ({ ok: true, text: async () => JSON.stringify({ answers: { p0: { choice: "r1" } } }) });
  // raw shape ({passageId}) must be rejected here — this is exactly the bug the
  // helper hit when whyFor re-validated its own normalized output.
  await assert.rejects(
    whyFor({ query: "fees", matches: [match("p0")] }, { config, fetchImpl: okFetch }),
    /normalized \{ id, sentence \}/,
  );
});
