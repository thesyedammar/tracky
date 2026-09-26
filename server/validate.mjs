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
  passagesMax: 600, // passages per search (the engine sweeps larger sets in chunks)
  totalCharsMax: 400_000,
  minBest: 0.58, // the best score must clear this for ANY results to show (re-tuned in Phase 11)
  resultsMax: 8, // ranked results surfaced by default
};

const ID_RE = /^p(0|[1-9]\d*)$/; // canonical: p0, p1, … — "p00" is malformed
const CHOICE_RE = /^s(0|[1-9]\d*)$/; // canonical: s0, s1, … — "s01" is malformed

/** Validate and normalize a search input. Returns { query, passages: [{id, text}] }. */
export function validateSearchInput(body) {
  if (!body || typeof body !== "object") throw new SearchError("Request body must be a JSON object.");
  const { query, passages } = body;
  if (typeof query !== "string" || !query.trim()) throw new SearchError("Enter something you want to find.");
  const q = query.trim();
  if (q.length > LIMITS.queryMax) throw new SearchError(`Keep your search under ${LIMITS.queryMax} characters.`);
  if (!Array.isArray(passages) || passages.length === 0) throw new SearchError("Send between 1 and 600 passages.");
  if (passages.length > LIMITS.passagesMax) throw new SearchError(`Send at most ${LIMITS.passagesMax} passages.`);

  const ids = new Set();
  let total = 0;
  const normalized = passages.map((p) => {
    if (!p || typeof p !== "object") throw new SearchError("Every passage must be { id, text }.");
    if (typeof p.id !== "string" || !ID_RE.test(p.id) || ids.has(p.id)) {
      throw new SearchError("Passage ids must be unique and look like p0, p1, …");
    }
    if (typeof p.text !== "string" || !p.text.trim()) throw new SearchError("A passage arrived empty.");
    if (p.text.length > LIMITS.passageMax) throw new SearchError(`A passage is over ${LIMITS.passageMax} characters.`);
    ids.add(p.id);
    total += p.text.length;
    return { id: p.id, text: p.text };
  });
  if (total > LIMITS.totalCharsMax) throw new SearchError("This document is too long — try a section under 400,000 characters.");
  return { query: q, passages: normalized };
}

const upstream = (what) => new SearchError(`Jev returned an incomplete evaluation (${what}). Try again.`, 502);

/** Probabilities are auxiliary (why-chips); they are validated and DROPPED if malformed. */
function cleanProbabilities(raw) {
  if (!raw || typeof raw !== "object") return null;
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
    if (!p || !Array.isArray(p.sentences)) throw upstream(`passage ${p?.id ?? "?"} not prepared`);
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
    const focusText = focusIndex === null ? null : p.sentences[focusIndex].text;
    if (focusText !== null && !p.text.includes(focusText)) throw upstream(`sentence for ${p.id} is not part of its passage`);
    return { id: p.id, score, focusIndex, focusText, choiceProbabilities };
  });
}

/**
 * Rank parsed answers for display. Policy (field-proven in the reference pipeline):
 * rank, don't cut — Jev scores are not comparable across searches, so a fixed
 * per-item cutoff would be wrong twice over. Show the top 3 whenever the best
 * score clears the sanity gate, extend with anything within 45% of the best,
 * cap at the display limit. If even the best is below the gate, show nothing —
 * an honest empty beats a weak guess. (Gate + band re-tuned in Phase 11.)
 * The never-fabricate substring guarantee is enforced in parseJevAnswers.
 */
export function rankResults(parsed, { minBest = LIMITS.minBest, topAlways = 3, ofBest = 0.55, limit = LIMITS.resultsMax } = {}) {
  const ranked = parsed
    .filter((r) => r.focusText !== null)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score < minBest) return [];
  const band = ranked[0].score * ofBest;
  return ranked
    .filter((r, i) => i < topAlways || r.score >= band)
    .slice(0, limit)
    .map((r) => ({ passageId: r.id, sentence: r.focusText, score: Math.round(r.score * 1000) / 1000 }));
}
