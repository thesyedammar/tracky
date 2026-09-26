// Sentence splitter specs — names describe the behaviour, not the implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { splitSentences } from "../sentences.mjs";

const texts = (s) => splitSentences(s).map((x) => x.text);

test("splits on question marks", () => {
  assert.deepEqual(texts("Is there a fee? There is."), ["Is there a fee?", "There is."]);
});

test("keeps Rs. amounts intact", () => {
  assert.deepEqual(texts("A fee of Rs.250 applies."), ["A fee of Rs.250 applies."]);
  assert.deepEqual(texts("Pay Rs. 250 now. Keep the receipt."), ["Pay Rs. 250 now.", "Keep the receipt."]);
});

test("keeps numbered list markers with their item", () => {
  const out = texts("1. First rule applies.\n2. Second rule applies.");
  assert.equal(out.length, 2);
  assert.match(out[0], /^1\. First rule/);
  assert.match(out[1], /^2\. Second rule/);
});

test("keeps e.g. and i.e. intact", () => {
  assert.deepEqual(texts("Bring ID, e.g. a passport. It helps."), ["Bring ID, e.g. a passport.", "It helps."]);
  assert.deepEqual(texts("The fine, i.e. the penalty, applies. Pay it."), ["The fine, i.e. the penalty, applies.", "Pay it."]);
});

test("keeps initials intact", () => {
  assert.deepEqual(texts("Signed by S. Hussain. Dated today."), ["Signed by S. Hussain.", "Dated today."]);
});

test("offsets point at the exact characters", () => {
  const src = "First one. Second one? Third one!";
  const parts = splitSentences(src);
  assert.equal(parts.length, 3);
  for (const s of parts) {
    assert.equal(s.text, src.slice(s.start, s.end));
  }
});

test("no leading or trailing whitespace in any sentence", () => {
  const src = "One.\n  Two.  \nThree.  ";
  for (const s of splitSentences(src)) {
    assert.equal(s.text, s.text.trim());
    assert.equal(s.text, src.slice(s.start, s.end));
  }
});

test("returns [] for empty or whitespace text", () => {
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("   \n  "), []);
});

test("a passage without terminal punctuation returns one sentence", () => {
  assert.deepEqual(texts("Just one line with no full stop"), ["Just one line with no full stop"]);
});

test("masks capitalized abbreviations too", () => {
  assert.deepEqual(texts("Deadline: E.g. Friday. Plan for it."), ["Deadline: E.g. Friday.", "Plan for it."]);
  assert.deepEqual(texts("Meet at 10 a.m. sharp. Late arrivals wait."), ["Meet at 10 a.m. sharp.", "Late arrivals wait."]);
});

test("keeps decimals intact", () => {
  assert.deepEqual(texts("A 3.14 km walk. Then stop."), ["A 3.14 km walk.", "Then stop."]);
});

test("non-string input throws instead of silently returning []", () => {
  assert.throws(() => splitSentences(null), TypeError);
  assert.throws(() => splitSentences(42), TypeError);
});
