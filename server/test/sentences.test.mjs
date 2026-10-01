// Sentence splitter specs — names describe the behaviour, not the implementation.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("fallback splitter keeps the exact-offset contract", async () => {
  const { splitSentencesFallback } = await import("../sentences.mjs");
  const text = "First sentence here. Is this second? Yes — third!";
  const out = splitSentencesFallback(text);
  assert.ok(out.length >= 2, `must split, got ${JSON.stringify(out)}`);
  for (const s of out) {
    assert.equal(s.text, text.slice(s.start, s.end), "text must be the exact original slice");
  }
});

test("fallback respects masked dots like the Intl path", async () => {
  const { splitSentencesFallback } = await import("../sentences.mjs");
  assert.deepEqual(
    splitSentencesFallback("A 3.14 km walk. Then stop.").map((s) => s.text),
    ["A 3.14 km walk.", "Then stop."],
  );
  assert.deepEqual(
    splitSentencesFallback("Mr Smith paid Rs 100. He left.").map((s) => s.text),
    ["Mr Smith paid Rs 100.", "He left."],
  );
});

test("STERM never matches across a newline (fall-through, not a match)", async () => {
  // Mechanism pin for the parity argument: "a!\nb" splits with the literal
  // "!" intact — if a future edit let STERM match "!"+newline, the mask would
  // substitute the DOT sentinel and the first segment would read "a<DOT>",
  // failing here even where Intl agrees (both split newlines). Exact-output
  // pin, in this file's established style (cf. masked-dots test above).
  const { splitSentencesFallback } = await import("../sentences.mjs");
  assert.deepEqual(
    splitSentencesFallback("a!\nb").map((s) => s.text),
    ["a!", "b"],
  );
  assert.deepEqual(
    splitSentencesFallback("Hey!\nGo.").map((s) => s.text),
    ["Hey!", "Go."],
  );
});

const HAS_SEGMENTER = typeof Intl.Segmenter === "function";
test("Intl and fallback agree on dots inside runs", { skip: !HAS_SEGMENTER && "needs live Intl.Segmenter for the Intl side — fallback-direct tests run everywhere" }, async () => {
  // The contract is PARITY, not just fallback sanity: whatever Intl does with
  // in-run dots, the fallback must do the same (probe-verified 8/8).
  const { splitSentencesFallback, splitSentences } = await import("../sentences.mjs");
  const battery = [
    "A 3.14 km walk. Then stop.",
    "Version 1.2.3 is out. Upgrade now.",
    "Mr Smith paid Rs 100. He left.",
    "١.٢ سعر. التالي.",
    "See report.pdf for details. It helps.",
    "a.b.c",
    "He left. She cried.",
    "Dr Jones is here. Sit down.",
    "He left. she cried.",
    "He left. 7 came.",
    "It broke... allegedly.",
    "End?” Next.",
    "…? yes.",
    "? “Next.”",
    "Wow!“ Really.",
    "! ‘Go.’",
    "He left. “She cried.”",
    "Say “hi.” Next.",
    "stop? (go).",
    "really?… yes.",
    "wait!—go.",
    "a!b",
    "Hi!Bye.",
    "What?Now.",
    "He left.  she cried.",
    "He left.   7 came.",
    "a!\nb",
    "Hey!\nGo.",
    "He left.\r\nshe cried.",
    "He left.\r\nShe cried.",
    "x.\ty.",
    "x.\tY.",
    "abc",
    "He left.. she cried.",
    "He left.. She cried.",
    "Wait...  what.",
    "x..y",
    "x.\u00a0y.",
    "x.\u00a0Y.",
    "He left.\u00a0she cried.",
    "x.\u202fy.",
    "x.\u2028y.",
    "A.B.",
    "A.B.C.",
    "a!1.",
    "a!\u0085b.",
    "a?\u0085b.",
    "x.\u0085y.",
    "x.\u0085Y.",
    "a\u0085b.",
    "x.\u2029y.",
    "He left.\u00a0 \u201dNext.\u201d",
  ];
  for (const text of battery) {
    assert.deepEqual(
      splitSentencesFallback(text).map((s) => s.text),
      splitSentences(text).map((s) => s.text),
      `parity on ${JSON.stringify(text)}`,
    );
  }
}); // end Intl/fallback parity

test("module regexes stay stateless (no test/exec, no lastIndex drift)", async () => {
  // The hoisted patterns are shared across calls: safe ONLY because every use
  // is .replace/.matchAll (which reset lastIndex). A future .test/.exec would
  // leak lastIndex into the next call — the grep half fails first. The rerun
  // half is behavioral: replace/matchAll with /g start at lastIndex, so a
  // leak would change the second run's output — identical reruns prove no
  // leak through the exercised paths.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../sentences.mjs", import.meta.url), "utf8");
  for (const name of ["ABBREV_RE", "INITIAL_RE", "LIST_RE", "DECIMAL_RE", "STERM_RE", "CURLY_RE", "NOBREAK_RE", "FALLBACK_RE"]) {
    assert.ok(!new RegExp(`\\b${name}\\.(test|exec)\\b`).test(src), `${name} must never be used with test/exec — lastIndex would leak across calls`);
  }
  const { splitSentences, splitSentencesFallback } = await import("../sentences.mjs");
  const input = "He left. she cried. End? Yes! Go 1.2.3. Wait... what?!";
  assert.deepEqual(splitSentences(input), splitSentences(input));
  assert.deepEqual(splitSentencesFallback(input), splitSentencesFallback(input));
});

test("Intl/fallback parity holds on 500 seeded word-salad inputs", { skip: !HAS_SEGMENTER && "needs live Intl.Segmenter for the Intl side — fallback-direct tests run everywhere" }, async () => {
  // Prose-model fuzz (deterministic seed — same strings every run, no flakes):
  // neutral-majority vocabulary the rules were never tuned for (pangram words,
  // titles, units, years, hyphenates) plus a few pinned regression tokens.
  // Char-salad (symbols glued to punctuation) is out of scope by design —
  // ICU subtleties no hand regex matches; Intl owns truth there (see
  // sentences.mjs header). Every input also asserts exact offsets and no
  // offset shift (a length-changing mask would push end past the input).
  const { splitSentencesFallback, splitSentences } = await import("../sentences.mjs");
  const words = [
    "the", "quick", "brown", "fox", "Pack", "my", "box", "five", "dozen", "liquor", "jugs",
    "How", "vexingly", "quick", "daft", "zebras", "jump", "Sphinx", "black", "quartz",
    "judge", "my", "vow", "Waltz", "nymph", "Glad", "Jensen", "Bourne", "wife",
    "St", "Ave", "etc", "Fig", "No", "pp", "Vol", "Ch", "Sec", "Jan", "Feb", "Mon",
    "a.m", "p.m", "U.K", "U.S", "e-mail", "co-operate", "mother-in-law", "well-known",
    "3:30", "1999", "2026", "42", "7th", "first", "second", "Mrs", "Ms", "Prof", "Sr", "Jr",
    "vs", "per", "cent", "Rs", "USD", "km", "kg", "Dr", "Mr", "Smith", "Jones",
    "said", "asked", "replied", "shouted", "price", "total", "report", "file", "section",
    "page", "line", "word", "day", "night", "morning",
    // pinned regression tokens (each once broke parity):
    "report.pdf", "3.14", "1.2.3", "192.168.1.1", "v2", "beta", "e.g", "U.S.A", "a.b.c", "١.٢", "stop…wait",
  ];
  const seps = [" ", " ", " ", " ", "\n", ", ", "; ", ": ", " — ", " (", ") "];
  const ends = [". ", "! ", "? ", '." ', '!" ', ") ", "; ", ": ", ", ", "… ", ".… ", " — ", "?” ", ".” "];
  let seed = 777;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rand() * a.length)];
  for (let n = 0; n < 500; n++) {
    const nw = 2 + Math.floor(rand() * 14);
    let text = "";
    for (let i = 0; i < nw; i++) {
      text += pick(words);
      const r = rand();
      if (i === nw - 1) text += pick([".", "!", "?", '."', '…"', ""]);
      else if (r < 0.25) text += pick(ends);
      else text += pick(seps);
    }
    if (!text.trim()) continue;
    assert.deepEqual(
      splitSentencesFallback(text).map((s) => s.text),
      splitSentences(text).map((s) => s.text),
      `parity on word-salad #${n} ${JSON.stringify(text)}`,
    );
    for (const s of splitSentencesFallback(text)) {
      assert.equal(s.text, text.slice(s.start, s.end), `exact offsets on #${n}`);
      assert.ok(s.end <= text.length, `no offset shift on #${n}`); // a length-changing mask would push end past the input
    }
  }
});

test("fallback keeps multi-dot numerics whole", async () => {
  const { splitSentencesFallback } = await import("../sentences.mjs");
  assert.deepEqual(
    splitSentencesFallback("Version 1.2.3 is out. Upgrade now.").map((s) => s.text),
    ["Version 1.2.3 is out.", "Upgrade now."],
  );
  assert.deepEqual(
    splitSentencesFallback("Ping 192.168.1.1 now. It works.").map((s) => s.text),
    ["Ping 192.168.1.1 now.", "It works."],
  );
});

test("fallback never emits zero slices for non-blank input", async () => {
  const { splitSentencesFallback } = await import("../sentences.mjs");
  const battery = ["...", ")", "…", "a.b.c", "!", "  x  ", "1.2.3", "?!", "—", "(hello)", "Mr Smith paid Rs 100.", "١.٢ سعر."]; // last: Arabic-Indic digits mask like ASCII
  for (const text of battery) {
    const out = splitSentencesFallback(text);
    assert.ok(out.length >= 1, `${JSON.stringify(text)} must yield at least one slice`);
    const covered = new Set();
    for (const s of out) {
      assert.equal(s.text, text.slice(s.start, s.end), `${JSON.stringify(text)}: slice must be the exact original`);
      assert.ok(s.end <= text.length, `${JSON.stringify(text)}: end must stay inside the input`);
      for (let i = s.start; i < s.end; i++) covered.add(i);
    }
    for (let i = 0; i < text.length; i++) {
      assert.ok(/\s/.test(text[i]) || covered.has(i), `${JSON.stringify(text)}: char ${i} (${JSON.stringify(text[i])}) was dropped`);
    }
  }
});

test("fallback treats a dots-only passage like Intl: one slice, not zero", async () => {
  const { splitSentencesFallback, splitSentences } = await import("../sentences.mjs");
  assert.deepEqual(splitSentencesFallback("...").map((s) => s.text), ["..."]);
  assert.deepEqual(splitSentences("...").map((s) => s.text), ["..."]);
});

test("fallback never drops leading punctuation", async () => {
  const { splitSentencesFallback } = await import("../sentences.mjs");
  const text = "! Hello. How are you?";
  const out = splitSentencesFallback(text);
  assert.equal(out.map((s) => s.text).join("").replace(/\s/g, ""), "!Hello.Howareyou?".replace(/\s/g, ""), "every non-space character must survive in some slice");
  for (const s of out) {
    assert.equal(s.text, text.slice(s.start, s.end), "text must be the exact original slice");
  }
  assert.ok(out.some((s) => s.text.includes("Hello.")), "the sentence itself must be intact");
});

test("splitSentences uses the fallback (same contract) with Intl.Segmenter hidden", () => {
  // A fresh process: hiding proves the import-time crash is gone AND the
  // fallback path engages (output identical to splitSentencesFallback).
  const script = [
    "Intl.Segmenter = undefined;",
    `const { splitSentences, splitSentencesFallback } = await import(${JSON.stringify(new URL("../sentences.mjs", import.meta.url).href)});`,
    "if (Intl.Segmenter !== undefined) throw new Error('not hidden');",
    "const text = 'First here. Second here? Yes!';",
    "const a = splitSentences(text), b = splitSentencesFallback(text);",
    "for (const s of a) if (s.text !== text.slice(s.start, s.end)) throw new Error('contract broken');",
    "if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('must use the fallback');",
    "console.log('FALLBACK-OK ' + a.length);",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.match(out, /FALLBACK-OK \d+/);
});
