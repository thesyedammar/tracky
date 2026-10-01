// Sentence splitter with exact character offsets — the ground truth for both
// in-page highlights and the choice-criterion options sent to Jev.
//
// Strategy: mask well-known abbreviation dots and list numbers with a sentinel
// character (same length → offsets unchanged), segment with Intl.Segmenter,
// then slice the ORIGINAL text so every returned sentence is character-exact.
// A sentence is ALWAYS original.slice(start, end) — the never-fabricate rule
// starts here. Decimals like "3.14" are never split (no whitespace after the dot).
// Parity scope: the fallback mirrors Intl on PROSE (what the collector feeds
// it — pinned by a 500-input seeded word-salad test). Pure symbol runs
// ("b.<+@à", "?;(") follow ICU subtleties no hand regex matches; Intl owns the
// truth there, and it is present on every runtime that matters.

const DOT = "\u0001"; // same-length stand-in for a protected dot

const ABBREVIATIONS = [
  // titles and prose (masked case-insensitively: "RS.", "E.g." both count)
  "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St", "vs", "etc", "approx", "Dept", "Inc", "Ltd", "Co", "Corp", "Fig",
  // months
  "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
  // Indian invoice vocabulary (matches the domain the tool was born in)
  "Rs", "No", "Nos", "Smt", "Sri", "Shri",
  // latin shorthand and clock times
  "e.g", "i.e", "a.m", "p.m",
];

const ABBREV_RE = new RegExp(`\\b(${ABBREVIATIONS.map((a) => a.replace(/\./g, "\\.")).join("|")})\\.`, "gi");
const INITIAL_RE = /\b([A-Z])\./g; // initials: "S. Hussain"
const LIST_RE = /(^|\n)(\s{0,3}\d{1,3})\.\s/g; // numbered list markers: "1. "
const DECIMAL_RE = /([\p{L}\p{Nd}])\.(?=[\p{L}\p{Nd}])/gu; // a dot with a letter/digit on BOTH sides ("3.14", "1.2.3", "١.٢", "a.b.c", "report.pdf", "a.b" — lookahead, so every dot in a run is masked). Intl keeps all of these whole (probed: no whitespace can follow an in-run dot, so it can never end a segment); the fallback must not split there either. Symbol-adjacent dots ("b.<", ".-") are OUT of scope: the fallback splits, Intl often doesn't — Intl owns the truth when present. (The word-salad fuzz runs fallback-vs-local-Intl every run, so an ICU behavior change inside covered cases goes red; it cannot vet runtimes without Segmenter or uncovered symbol-soup.)
// ! and ? split aggressively (even "a!b" → "a!" + "b"), but NOT when glued to a
// symbol: Intl keeps "!(?", "?:", "!—go" and "?!" whole. So mask !/? only when
// directly attached to a symbol — a blank/EOS/newline after it still splits,
// but by falling THROUGH the mask, not by matching it (newline is \s, excluded
// from the symbol class alongside blanks; NEL is excluded too, but ONLY by the
// explicit \x85 — \s never covers U+0085, so without it NEL would
// wrongly match as a symbol).
// Mechanism (exclusion: NEL never matches as a symbol, so !/? fall through) vs
// reason (Intl treats NEL as a line break — probed "a!\x85b" splits, like \n;
// boundary NEL is stripped by trimEdges on both paths).
// Quotes and ellipsis are transparent ("really?… yes." still splits at the ?).
// Shared quote inventory — four constants, each with a stated job, every
// consumer below built from them (no copied literals, so nothing drifts):
// QCLOSE (straight " ' ) ]) is transparent to both guards; ELLIPSIS (U+2026)
// joins the same transparent class without being a closer; CURLY_CLOSE
// (U+201D/U+2019) suppresses !/? splits in CURLY_RE AND stays transparent to
// NOBREAK AND is consumed by the fallback; CURLY_OPEN (U+201C/U+2018) is
// transparent to NOBREAK only (a spaced open still splits, like a straight
// quote — probed parity, see CURLY_RE's comment).
const QCLOSE = "\"'\\)\\]";
const ELLIPSIS = "…";
const CURLY_CLOSE = "\u201d\u2019"; // U+201D U+2019: suppress !/? splits (CURLY_RE), transparent to NOBREAK, consumed by the fallback
const CURLY_OPEN = "\u201c\u2018"; // U+201C U+2018: transparent to NOBREAK only (a spaced open still splits, like a straight quote)
const STERM_RE = new RegExp(`([!?])(?=[${QCLOSE}${ELLIPSIS}]*[^\\p{L}\\p{Nd}\\s\x85${QCLOSE}${ELLIPSIS}])`, "gu");
// A curly close directly after !/? suppresses the split ("End?” Next." stays
// whole — but a straight quote still splits: 'Say "hi?" Next.'). Dots do NOT
// get this treatment (”.” + Upper still splits: "He left.” She cried.").
// Asymmetry, probed: OPEN curlies suppress only when attached ("?“x.”" whole)
// but split across a blank ('? “Next.”' splits, like a straight quote) —
// CURLY_RE therefore covers close curlies only; spaced opens fall through to
// the blank rule and split, which is what Intl does.
const CURLY_RE = new RegExp(`([!?])(?=[${CURLY_CLOSE}])`, "gu");
// A dot that cannot end a sentence: followed (across skippable matter) by a
// lowercase letter or digit. The skip set is one merged class: every
// non-break whitespace ([^\S\n\r\u2028\u2029] — space, tab, NBSP, narrow-NBSP, and
// friends; newlines/CR/line-separators excluded so they still break) plus dots, ellipsis
// and closers of every shape (QCLOSE + CURLY_OPEN + CURLY_CLOSE). The dot's
// sentence-ending power depends on the next word's case, so all of
// that is transparent here. (STERM's QCLOSE stays ASCII-only on purpose:
// ?/! glued to an open curly must still mask.) Probed NBSP parity:
// "x.\u00a0y." whole, "x.\u00a0Y." split, "He left.\u00a0she cried." whole.
// U+2028/29 break on both paths (pinned in battery); NEL splits on both paths
// too — three distinct mechanisms: !/?-adjacent (STERM never matches NEL as a
// symbol, so they fall through; pinned "a!\u0085b."), dot-adjacent (NEL
// is absent from NOBREAK_RE's skip class, so the dot stays unmasked and
// splits; pinned "x.\u0085y."), and bare-interior (own \x85+
// fallback alternative, pinned "a\u0085b."). trimEdges aligns attachment
// on both paths. No NEL residual remains;
// NEL is vanishingly rare in real text regardless.
// Intl keeps "He left. she cried.", "v2. beta" and "He left. 7 came." whole.
const NOBREAK_RE = new RegExp(`\\.(?=(?:[^\\S\\n\\r\\u2028\\u2029]|[${ELLIPSIS}.${CURLY_OPEN}${CURLY_CLOSE}${QCLOSE}])*[\\p{Ll}\\p{Nd}])`, "gu");
// trim() misses NEL (U+0085): a line break that is not JS whitespace. Both
// split paths strip boundary whitespace to honor the no-leading/trailing
// contract below — strip NEL there too, from one shared pattern (.replace
// resets lastIndex every call, so the module-level /g is stateless in use).
const trimEdges = (s) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
const trimStartEdges = (s) => s.replace(/^[\s\u0085]+/, "");
// dot+whitespace, the run mask needs dot+letter/digit — disjoint by construction),
// so their relative order does not matter.

function mask(text) {
  return text
    .replace(ABBREV_RE, `$1${DOT}`)
    .replace(INITIAL_RE, `$1${DOT}`)
    .replace(LIST_RE, `$1$2${DOT} `)
    .replace(DECIMAL_RE, `$1${DOT}`)
    .replace(STERM_RE, DOT) // the match IS the mark (lookahead only peeks) — no $1, or offsets shift
    .replace(CURLY_RE, DOT) // same: lookahead-only match, the mark itself is replaced
    .replace(NOBREAK_RE, DOT); // same-length: offsets unchanged on both split paths
}

/** The segmenter, built once on first use (never at import: a runtime without
 *  Intl.Segmenter must fail one search, not kill the helper at load). Null
 *  where Intl.Segmenter is missing OR its constructor throws (e.g. a future
 *  bad locale) — either way the fallback owns segmentation for the process
 *  lifetime by design: Segmenter construction is expensive and the runtime's
 *  Intl presence does not change under a running helper. */
let cachedSeg; // undefined = unprobed; null = probed, Segmenter missing here
function getSegmenter() {
  if (cachedSeg === undefined) {
    try {
      cachedSeg = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
    } catch {
      cachedSeg = null; // constructor threw: fall back below
    }
  }
  return cachedSeg;
}

/** Fallback splitter when Intl.Segmenter is missing: terminal punctuation runs.
 *  Boundaries are found on the MASKED text (so "3.14" and "1. " never split,
 *  exactly like the Intl path) but slices come from the ORIGINAL — masking is
 *  same-length, so offsets land on the real characters. Same contract. */
// Shared: matchAll clones the pattern per call and never mutates lastIndex —
// safe to hoist (no .test/.exec touches it anywhere). The mask regexes above
// are hoisted on the same terms: .replace with /g resets lastIndex every call,
// so all eight module-level patterns (ABBREV/INITIAL/LIST/DECIMAL/STERM/CURLY/
// NOBREAK via replace, FALLBACK via matchAll) are stateless in use. Recompiling per
// passage would cost 1200 compiles on a full page for nothing.
const FALLBACK_RE = new RegExp(`(?:[^.!?\\n\\x85]+)?[.!?]+[${QCLOSE}${CURLY_CLOSE}]*|\\n+|\\x85+|[^.!?\\n\\x85]+`, "g"); // CURLY_CLOSE (close-curlies only); NEL own-segment like newline
export function splitSentencesFallback(text) {
  const masked = mask(text);
  const out = [];
  // The leading run is optional: a sentence may OPEN with punctuation ("! Hello")
  // and that mark must still appear in the slices — dropping input breaks the
  // exact-offset contract.
  // … (U+2026) is NOT terminal: Intl never splits at it ("wait…what now." and
  // even "stop… Go." stay one segment), while !?. split aggressively — even
  // without a following space ("a!b" → "a!" + "b"). The classes below mirror that.
  // The consuming fallback: same quote inventory as the masks above, so the
  // "single source" holds for this path too ([QCLOSE + CURLY_CLOSE], no
  // duplicates — the old literal carried "" and '' twice).
  for (const m of masked.matchAll(FALLBACK_RE)) {
    const lead = m[0].length - trimStartEdges(m[0]).length;
    const core = trimEdges(m[0]);
    if (!core || /^\n+$/.test(core)) continue; // blank lines are separators (Intl emits no segment); a dots-only run IS a segment ("..." → one slice, like Intl)
    const start = m.index + lead;
    out.push({ start, end: start + core.length, text: text.slice(start, start + core.length) });
  }
  return out;
}

/**
 * Split `text` into sentences: [{ start, end, text }] where
 * `text === original.slice(start, end)` exactly, with no leading or trailing
 * whitespace (NEL included — trim() alone misses it, trimEdges covers it). Offsets are into the ORIGINAL string (masking is same-length).
 * Non-string input throws — silence would hide a bug upstream.
 */
export function splitSentences(text) {
  if (typeof text !== "string") throw new TypeError("splitSentences expects a string");
  const out = [];
  if (!trimEdges(text)) return out;
  const masked = mask(text);
  const segmenter = getSegmenter();
  if (!segmenter) return splitSentencesFallback(text); // same contract, dumber boundaries
  for (const { segment, index } of segmenter.segment(masked)) {
    const lead = segment.length - trimStartEdges(segment).length;
    const core = trimEdges(segment);
    if (!core) continue; // whitespace-only segment
    const start = index + lead;
    out.push({ start, end: start + core.length, text: text.slice(start, start + core.length) });
  }
  return out;
}
