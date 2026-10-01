// Input validation and Jev-answer adjudication — the no-fabrication gate.
//
// Everything between the helper and Jev passes through here: inputs are checked
// before a request is built; answers are checked before a single highlight is
// allowed near a page. Validation failures throw SearchError, and the helper
// maps that to a clean HTTP error. Nothing is ever guessed or repaired.

export class SearchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "SearchError";
    this.status = status;
  }
}

export const LIMITS = {
  queryMax: 400,
  passageMax: 2200, // chars per passage
  passagesMax: 1200, // engine safety cap; the extension collects ≤600 per contract (frozen v1)
  totalCharsMax: 400_000,
  totalBytesMax: 400_000, // SERIALIZED bytes, not raw: quotes/backslashes/controls/CJK all inflate on the wire, and the transport cap counts wire bytes. 400 KB of passage JSON + ids/query overhead always fits the 512 KB body cap — a validated request can never 413 on passage text
  minBest: 0.58, // the best score must clear this for ANY results to show (re-tuned in Phase 11)
  resultsMax: 8, // ranked results surfaced by default
};

const ID_RE = /^p(0|[1-9]\d{0,4})$/; // canonical: p0, p1, … — "p00" is malformed. Defense in depth beside the byte cap (which measures the exact wire bytes incl. ids): the shape rejects garbage early with a clear 400, and the 6-char ceiling keeps any single id trivially small
const CHOICE_RE = /^s(0|[1-9]\d*)$/; // canonical: s0, s1, … — "s01" is malformed

/** Validate and normalize a search input. Returns { query, passages: [{id, text}] }. */
export function validateSearchInput(body) {
  if (!body || typeof body !== "object") throw new SearchError("Request body must be a JSON object.");
  const { query, passages } = body;
  if (typeof query !== "string" || !query.trim()) throw new SearchError("Enter something you want to find.");
  const q = query.trim();
  if (q.length > LIMITS.queryMax) throw new SearchError(`Keep your search under ${LIMITS.queryMax} characters.`);
  if (!Array.isArray(passages) || passages.length === 0) throw new SearchError("Send between 1 and 1200 passages.");
  if (passages.length > LIMITS.passagesMax) throw new SearchError(`Send at most ${LIMITS.passagesMax} passages.`);

  const ids = new Set();
  let total = 0;
  let idChars = 0;
  const normalized = passages.map((p) => {
    if (!p || typeof p !== "object") throw new SearchError("Every passage must be { id, text }.");
    if (typeof p.id !== "string" || !ID_RE.test(p.id) || ids.has(p.id)) {
      throw new SearchError("Passage ids must be unique and look like p0, p1, …");
    }
    if (typeof p.text !== "string" || !p.text.trim()) throw new SearchError("A passage arrived empty.");
    if (p.text.length > LIMITS.passageMax) throw new SearchError(`A passage is over ${LIMITS.passageMax} characters.`);
    ids.add(p.id);
    total += p.text.length;
    idChars += Buffer.byteLength(p.id); // BYTES not chars: the exact wire cost, sound for any charset ID_RE may ever allow — no ASCII coupling by construction.
    return { id: p.id, text: p.text };
  });
  if (total > LIMITS.totalCharsMax) throw new SearchError("This document is too long — try a section under 400,000 characters.");
  // Wire bytes of the normalized array in ONE stringify: ids, scaffolding,
  // commas and brackets included — exactly what the transport measures.
  // Skipped when provably unnecessary: bound <= cap implies true <= cap, so
  // > skips the stringify with no loss; the bound may measure unnecessarily,
  // never skip wrongly. Term-by-term derivation (6B units, 21/n share,
  // query-derived slack, the two coincident 21s) lives atop the scaffolding test in
  // test/validate.test.mjs — read it before touching the formula.
  // One binding, two roles: the > here is the fast-path TRIGGER (skip at or
  // under the cap), the > at the stringify comparison is the TRUE CAP (pass
  // at equality). Same constant, same operator.
  // NOTE the layering: this bounds the DOCUMENT payload. Per-request
  // question scaffolding (relevance + focus texts, sentence criteria) is
  // bounded separately by chunkPrepared's cost model (text ×2 for
  // state+criteria, +640/passage, ≤80 passages/chunk, estimator ≤140 KB),
  // so each dispatched body stays far under the 512 KB transport cap with
  // 413-halving as the backstop. Typical requests pay nothing here; only
  // near-cap payloads pay one ~6 ms pass.
  const TEXT_WIRE_MAX = 6 * total; // <=6 B per unit (U+XXXX escapes, lone surrogates; CJK 3, astral pairs 2)
  const ID_WIRE = idChars; // exact bytes, not 6*n: the id cap would allow that bound, but exact keeps the fast path tight (fewer slow-path measures)
  const SCAFFOLD_WIRE_MAX = 21 * normalized.length; // 19 B fixed + array share (brackets + commas: 2 B at n=1, ~1 B/passage at scale)
  const QUERY_ENVELOPE_SLACK = LIMITS.queryMax * 6 + 100; // worst-case query on the wire + request envelope
  if (TEXT_WIRE_MAX + ID_WIRE + SCAFFOLD_WIRE_MAX + QUERY_ENVELOPE_SLACK > LIMITS.totalBytesMax) {
    const totalJson = Buffer.byteLength(JSON.stringify(normalized));
    // Raw bytes lie: 400 KB of quotes is ~800 KB once JSON-escaped and would die
    // at the transport's byte cap with a bare 413. Fail here instead, with the reason.
    if (totalJson > LIMITS.totalBytesMax) throw new SearchError("This document is too long once encoded — try a smaller section.");
  }
  return { query: q, passages: normalized };
}

const upstream = (what) => new SearchError(`Jev returned an incomplete evaluation (${what}). Try again.`, 502);

/** Probabilities are auxiliary (why-chips); they are validated and DROPPED if malformed. */
function cleanProbabilities(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const vals = Object.values(raw);
  const ok = vals.length > 0 && vals.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
  return ok ? raw : null;
}

/**
 * Adjudicate a Jev response against the prepared passages.
 * Returns one entry per passage: { id, score, focusText, focusIndex, choiceProbabilities }.
 * focusText is ALWAYS an exact substring of the passage — it comes from
 * splitSentences, and is re-verified with a substring belt before it leaves here.
 * Throws SearchError(502) on any malformed or out-of-range answer.
 */
export function parseJevAnswers(data, passages) {
  const answers = data?.answers;
  if (!answers || typeof answers !== "object") throw upstream("missing answers object");
  if (!Array.isArray(passages) || passages.length === 0) throw upstream("no passages to adjudicate");

  return passages.map((p) => {
    if (!p || !Array.isArray(p.sentences) || p.sentences.length === 0) throw upstream(`passage ${p?.id ?? "?"} not prepared`);
    const a = answers[p.id];
    const score = a?.noul ?? a?.probability;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw upstream(`bad score for ${p.id}`);
    }

    let focusIndex = null;
    let choiceProbabilities = null;
    if (p.sentences.length === 1) {
      focusIndex = 0;
    } else if (p.sentences.length > 1) {
      const f = answers[`focus_${p.id}`];
      const m = CHOICE_RE.exec(f?.choice ?? "");
      const idx = m ? Number(m[1]) : -1;
      if (idx < 0 || idx >= p.sentences.length) throw upstream(`bad sentence pick for ${p.id}`);
      focusIndex = idx;
      choiceProbabilities = cleanProbabilities(f.probabilities);
    }
    const focus = focusIndex === null ? null : p.sentences[focusIndex];
    const focusText = focus?.text ?? null;
    const focusStart = focus?.start ?? null;
    if (focusText !== null) {
      // The substring belt: exact slice at an integer offset, or nothing passes.
      const at = Number.isInteger(focusStart) ? p.text.slice(focusStart, focusStart + focusText.length) : null;
      if (at !== focusText) throw upstream(`sentence for ${p.id} is not part of its passage`);
    }
    return { id: p.id, score, focusIndex, focusText, focusStart, choiceProbabilities };
  });
}

/**
 * Rank parsed answers for display. Policy: rank, don't cut — Jev scores are not
 * comparable across searches, so a fixed per-item cutoff would be wrong. Gate:
 * if the best score is below the sanity gate, show nothing (an honest empty beats
 * a weak guess). Then keep everything within 45% of the best score, best first,
 * capped at the display limit. (Live evidence 2026-09-27: "top 3 always" dragged
 * 0.03–0.09 stragglers into real results — the band alone is the right shape.
 * Gate + band re-tuned in Phase 11's benchmark.)
 * The never-fabricate substring guarantee is enforced in parseJevAnswers.
 */
export function rankResults(parsed, { minBest = LIMITS.minBest, ofBest = 0.55, limit = LIMITS.resultsMax } = {}) {
  if (!Array.isArray(parsed)) throw new SearchError("rankResults expects an array.", 500);
  if (!Number.isFinite(minBest) || minBest < 0 || minBest > 1) throw new SearchError("minBest must be between 0 and 1.", 500);
  if (!Number.isFinite(ofBest) || ofBest <= 0 || ofBest > 1) throw new SearchError("ofBest must be a fraction between 0 and 1.", 500);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.resultsMax) throw new SearchError(`limit must be an integer between 1 and ${LIMITS.resultsMax}.`, 500);
  const ranked = parsed
    .filter((r) => r.focusText !== null)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < minBest) return [];
  const band = ranked[0].score * ofBest;
  return ranked
    .filter((r) => r.score >= band)
    .slice(0, limit)
    .map((r) => ({
      passageId: r.id,
      sentence: r.focusText,
      score: Math.round(r.score * 1000) / 1000,
      offset: r.focusStart, // exact char offset of `sentence` inside its passage
    }));
}
