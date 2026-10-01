// Redact mode — mask PII in passage text BEFORE it would leave for Jev.
//
// Masking is SAME-LENGTH: every masked character becomes "•", so sentence
// offsets, highlights and the no-fabrication gate keep working unchanged on the
// original text. Receipts show the bullets — that is the point: what we would
// not send, we also do not echo back.
//
// Policy boundary: short money ("Rs.250", "Rs.5,000") and dates ("1 January
// 2026") survive — they are the content these searches exist for. Long digit
// runs (10+) are masked even next to ₹ — in an opt-in privacy mode,
// over-masking beats leaking.

export const MASK = "•";

export const RULES = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // UPI handles (john.doe@okhdfc): no dot-TLD, so the email rule above never
  // fires. Runs after it, so dotted addresses are already bullets (• is outside
  // every class here and can never re-match). Privacy-first like the rest:
  // an occasional "me@home" in prose is masked too — over-masking beats leaking.
  { name: "upi", re: /[A-Za-z0-9._%+-]{2,}@[A-Za-z]{2,}(?![A-Za-z])/g },
  // PAN-like 5 letters + 4 digits + 1 letter (PANs are uppercase by format);
  // no \b guards, so letter-adjacent forms like XABCDE1234F still get masked.
  { name: "pan", re: /[A-Z]{5}[0-9]{4}[A-Z]/g },
  { name: "phone_intl", re: /(?<!\d)\+\d[\d\s().-]{7,16}\d(?!\d)/g },
  { name: "phone_in", re: /(?<!\d)[6-9]\d{4}[ -]?\d{5}(?!\d)/g },
  { name: "phone_us", re: /(?<!\d)\(*\d{3}\)?[-. ]?\d{3}[-. ]\d{4}(?!\d)/g },
  // Digit-run rules are privacy-first: digit lookarounds instead of \b, so runs
  // glued to letters are caught too. Short money stays readable — that is the content.
  { name: "phone_bare", re: /(?<!\d)\d{10,11}(?!\d)/g },
  { name: "long_number", re: /(?<!\d)\d{12,}(?!\d)/g },
  { name: "grouped_number", re: /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}(?:[ -]\d{4})?(?!\d)/g },
];

/** Mask PII in `text`. Returns { text, counts } with a per-rule count (for counts-only logging). */
export function redactText(text) {
  const counts = {};
  let out = text;
  for (const { name, re } of RULES) {
    out = out.replace(re, (match) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return MASK.repeat(match.length);
    });
  }
  return { text: out, counts };
}
