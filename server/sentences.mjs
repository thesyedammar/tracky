// Sentence splitter with exact character offsets — the ground truth for both
// in-page highlights and the choice-criterion options sent to Jev.
//
// Strategy: mask well-known abbreviation dots and list numbers with a sentinel
// character (same length → offsets unchanged), segment with Intl.Segmenter,
// then slice the ORIGINAL text so every returned sentence is character-exact.
// A sentence is ALWAYS original.slice(start, end) — the never-fabricate rule
// starts here. Decimals like "3.14" are never split (no whitespace after the dot).

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

function mask(text) {
  return text
    .replace(ABBREV_RE, `$1${DOT}`)
    .replace(INITIAL_RE, `$1${DOT}`)
    .replace(LIST_RE, `$1$2${DOT} `);
}

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/**
 * Split `text` into sentences: [{ start, end, text }] where
 * `text === original.slice(start, end)` exactly, with no leading or trailing
 * whitespace. Offsets are into the ORIGINAL string (masking is same-length).
 * Non-string input throws — silence would hide a bug upstream.
 */
export function splitSentences(text) {
  if (typeof text !== "string") throw new TypeError("splitSentences expects a string");
  const out = [];
  if (!text.trim()) return out;
  const masked = mask(text);
  for (const { segment, index } of segmenter.segment(masked)) {
    const lead = segment.length - segment.trimStart().length;
    const core = segment.trim();
    if (!core) continue; // whitespace-only segment
    const start = index + lead;
    out.push({ start, end: start + core.length, text: text.slice(start, start + core.length) });
  }
  return out;
}
