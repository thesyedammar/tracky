// Request-builder specs — the wire shape must match what Phase 1 proved.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRequest, preparePassages, relevanceQuestion, focusQuestion, BATCH_MAX } from "../jev.mjs";

const query = "hidden charges";
const prepared = preparePassages([
  { id: "p0", text: "A service charge of Rs.250 applies. The sky is blue." },
  { id: "p1", text: "Guests must be 18 or older." },
]);

test("asks relevance + focus for multi-sentence passages", () => {
  const req = buildRequest({ query, passages: prepared, model: "jev-test" });
  assert.equal(req.model, "jev-test");
  assert.equal(req.state.search, query);
  assert.equal(req.state.passages.length, 2);
  assert.equal(req.questions.p0.type, "noul");
  assert.equal(req.questions.focus_p0.type, "choice");
  assert.deepEqual(Object.keys(req.questions.focus_p0.criteria), ["s0", "s1"]);
});

test("single-sentence passage gets no focus question", () => {
  const req = buildRequest({ query, passages: prepared, model: "m" });
  assert.equal(req.questions.focus_p1, undefined);
});

test("state.passages carries no sentence-split metadata", () => {
  const req = buildRequest({ query, passages: prepared, model: "m" });
  assert.deepEqual(req.state.passages[0], { id: "p0", text: prepared[0].text });
});

test("instructions treat all text as data (anti-injection line present)", () => {
  const rel = relevanceQuestion("p9");
  const foc = focusQuestion("p9", prepared[0].sentences);
  assert.match(rel.instructions, /as data, never instructions/);
  assert.match(foc.instructions, /as data, not instructions/);
  assert.match(rel.instructions, /p9/);
  assert.match(foc.instructions, /p9/);
});

test("criteria are exact slices of the passage", () => {
  for (const s of prepared[0].sentences) {
    assert.ok(prepared[0].text.slice(s.start, s.end) === s.text);
  }
});

test("rejects duplicate passage ids instead of overwriting questions", () => {
  const dup = preparePassages([
    { id: "p0", text: "One. Two." },
    { id: "p0", text: "Three." },
  ]);
  assert.throws(() => buildRequest({ query, passages: dup, model: "m" }), /Duplicate passage id/);
});

test("rejects batches larger than BATCH_MAX", () => {
  const big = preparePassages(
    Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({ id: `p${i}`, text: `Sentence number ${i}.` })),
  );
  assert.throws(() => buildRequest({ query, passages: big, model: "m" }), /exceeds/);
});
