// Redaction specs — same-length masking, money survives, cards/emails/phones go.
import test from "node:test";
import assert from "node:assert/strict";
import { redactText, MASK } from "../redact.mjs";

test("masks emails, phones, PAN and long IDs — same length, offsets never move", () => {
  const src = "Write to john.doe@example.com or call +91 98765 43210. PAN ABCDE1234F. Aadhaar 1234 5678 9012.";
  const { text, counts } = redactText(src);
  assert.equal(text.length, src.length);
  assert.ok(!text.includes("john.doe@example.com"));
  assert.ok(!text.includes("98765"));
  assert.ok(!text.includes("ABCDE1234F"));
  assert.ok(!text.includes("1234 5678 9012"));
  assert.ok(text.includes(MASK));
  assert.equal(counts.email, 1);
  assert.equal(counts.pan, 1);
  assert.ok(counts.phone_intl >= 1);
});

test("rupee amounts, dates and ordinals survive untouched", () => {
  const src = "A fee of Rs.5,000 applies on 1 January 2026 and Rs. 250 after 24 hours.";
  const { text, counts } = redactText(src);
  assert.equal(text, src);
  assert.deepEqual(counts, {});
});

test("bare 10-digit runs are masked in redact mode (over-masking beats leaking)", () => {
  const { text } = redactText("Call 9876543210 or 1234567890 for support.");
  assert.ok(text.includes("•".repeat(10)));
  assert.ok(!text.includes("1234567890"));
  assert.ok(!redactText("Total Rs.1234567890 due.").text.includes("1234567890"), "amount-adjacent runs are masked too");
});

test("runs glued to letters are still masked (digit lookarounds, not \\b)", () => {
  assert.ok(!redactText("mail me at a(415) 555-1234 now.").text.includes("1234"));
  assert.ok(!redactText("id abc1234567890 end.").text.includes("1234567890"));
  assert.ok(!redactText("ref XABCDE1234F end.").text.includes("ABCDE1234F"));
});

test("card-style grouped digits are masked", () => {
  const src = "Card 4111 1111 1111 1111 on file.";
  const { text } = redactText(src);
  assert.ok(!text.includes("4111"));
  assert.equal(text.length, src.length);
});

test("US-style phone numbers are masked in all common forms", () => {
  for (const p of ["415-555-1234", "415.555.1234", "415 555 1234", "(415) 555-1234"]) {
    const { text, counts } = redactText(`Call ${p} now.`);
    assert.ok(!text.includes("1234"), `not masked: ${p}`);
    assert.equal(counts.phone_us, 1, `rule did not fire for ${p}`);
  }
  assert.ok(!redactText("Call (415) 555-1234 now.").text.includes("("), "the opening paren must be masked too");
  assert.ok(!redactText("See ((415) 555-1234 now.").text.includes("("), "the whole paren chain must be masked");
  assert.ok(!redactText("Bare 4155551234 and ((415) 555-1234 both go.").text.includes("1234"), "no digit run may survive");
});
