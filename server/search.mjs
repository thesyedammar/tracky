// The search engine — one query over many passages: chunked Jev passes, merged,
// deduped, ranked. This is the module the helper (Phase 4) calls; the CLI
// (spikes/search-cli.mjs) exercises it today.
import { validateSearchInput, parseJevAnswers, rankResults, SearchError } from "./validate.mjs";
import { preparePassages, buildRequest, BATCH_MAX } from "./jev.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

/** The model's own input cap, measured live (not guessed): a 65,291-token request
 *  passed and a ~66k one came back {"detail":{"error_type":"max_tokens_exceeded"}} —
 *  a 64k (65,536) input-token ceiling. Request body chars → tokens runs ~0.30 for the
 *  densest text seen (a 58-page academic PDF; plain English is ~0.25), so this budget
 *  leaves about 25% headroom on that ratio. Chunks are sized by the REQUEST, never by
 *  passage count alone: every passage carries its sentences twice (text + focus
 *  criteria) plus two questions, so the body runs ~2.5x the passage text. */
export const MAX_BODY_CHARS = 140_000;

/** The route's own error type, when it sends one: {"detail":{"error_type":"…"}}. */
export function upstreamErrorType(text) {
  try {
    const d = JSON.parse(text);
    return d?.detail?.error_type || d?.error?.type || null;
  } catch {
    return null;
  }
}

/**
 * Split prepared passages into request-sized chunks: up to BATCH_MAX passages, and
 * never a request whose body would run past MAX_BODY_CHARS. Sized by the request, not
 * by passage count — a dense document must not die on the model's token cap (it used
 * to: "search failed — Jev answered HTTP 400" on a 58-page paper whose 80-passage
 * batch measured 237,806 body chars ≈ 71k tokens).
 */
export function chunkPrepared(prepared, { maxBodyChars = MAX_BODY_CHARS } = {}) {
  if (!Number.isFinite(maxBodyChars) || maxBodyChars <= 0) {
    throw new SearchError("maxBodyChars must be a positive number.", 500);
  }
  const chunks = [];
  let cur = [];
  let est = 400; // the request scaffold: model, state.search, questions braces
  for (const p of prepared) {
    // Measured, not guessed: text + criteria (which duplicate the sentences, keys and
    // all) + two question texts + ids. A 2,040-char passage with 120 sentences really
    // costs 5,757 body chars — the per-sentence keys are why the count is here.
    const cost = p.text.length * 2 + p.sentences.length * 10 + 640;
    if (cur.length && (cur.length >= BATCH_MAX || est + cost > maxBodyChars)) {
      chunks.push(cur);
      cur = [];
      est = 400;
    }
    cur.push(p);
    est += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Run a meaning-search.
 * opts: { config: {baseUrl, model, apiKey}, fetchImpl, timeoutMs, signal, rank, onProgress }
 * returns { results, stats: { chunks, passages, ms, usage: {input_tokens, output_tokens} } }
 */
export async function searchText({ query, passages }, opts = {}) {
  const { config, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal, rank, onProgress } = opts;
  if (!config?.baseUrl || !config?.model || !config?.apiKey) {
    throw new SearchError("The helper is missing its Jev configuration.", 500);
  }
  if (rank != null && (typeof rank !== "object" || Array.isArray(rank))) throw new SearchError("rank overrides must be an object.", 500);
  if (onProgress != null && typeof onProgress !== "function") throw new SearchError("onProgress must be a function.", 500);
  if (signal != null && !(signal instanceof AbortSignal)) throw new SearchError("signal must be an AbortSignal.", 500);
  const input = validateSearchInput({ query, passages });
  const prepared = preparePassages(input.passages);
  const chunks = chunkPrepared(prepared);

  const started = performance.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const consumed = [];
  let requests = 0;

  /** One request, with the model's own token cap handled instead of feared: a "too
   *  big" answer splits the chunk in half and retries each half (down to a single
   *  passage), so a dense document completes instead of failing the whole search.
   *  Only a single passage too big on its own is a real failure (413). */
  const askChunk = async (chunk) => {
    if (signal?.aborted) throw new SearchError("Search cancelled.", 499); // cancelled during a previous pass
    const body = buildRequest({ query: input.query, passages: chunk, model: config.model });
    requests++;
    try {
      const { data } = await askJev(body, { config, fetchImpl, timeoutMs, signal });
      usage.input_tokens += Number(data?.usage?.input_tokens) || 0;
      usage.output_tokens += Number(data?.usage?.output_tokens) || 0;
      consumed.push(...parseJevAnswers(data, chunk));
      onProgress?.({
        done: consumed.length,
        total: prepared.length,
        chunk: requests,
        chunks: chunks.length,
      });
    } catch (e) {
      if (e?.status !== 413 || chunk.length === 1) throw e;
      const mid = Math.ceil(chunk.length / 2);
      await askChunk(chunk.slice(0, mid));
      await askChunk(chunk.slice(mid));
    }
  };

  for (const chunk of chunks) await askChunk(chunk);
  return {
    results: rankResults(dedupeResults(consumed), rank ?? {}),
    stats: { chunks: chunks.length, requests, passages: prepared.length, ms: Math.round(performance.now() - started), usage },
  };
}

/**
 * Merge across passes: identical sentences (nav fragments repeat on real pages)
 * collapse to their best-scoring hit, so one line is never shown or highlighted
 * twice. Entries without a sentence pass through (they are filtered at rank).
 */
export function dedupeResults(parsed) {
  if (!Array.isArray(parsed)) throw new SearchError("dedupeResults expects an array.", 500);
  const best = new Map();
  const rest = [];
  for (const r of parsed) {
    if (r.focusText === null) {
      rest.push(r);
      continue;
    }
    const key = r.focusText; // sentences are whitespace-trimmed by the splitter
    const prev = best.get(key);
    if (!prev || r.score > prev.score) best.set(key, r);
  }
  return [...best.values(), ...rest];
}

/** One HTTP call to Jev: hard timeout, outer-signal aware, every failure a SearchError. */
export async function askJev(body, { config, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  if (!config?.baseUrl || !config?.model || !config?.apiKey) throw new SearchError("The helper is missing its Jev configuration.", 500);
  if (typeof fetchImpl !== "function") throw new SearchError("fetchImpl must be a function.", 500);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SearchError("timeoutMs must be a positive number.", 500);
  const limiter = AbortSignal.timeout(timeoutMs);
  const anySignal = signal ? AbortSignal.any([limiter, signal]) : limiter;
  // Failure mapping: a cancel outranks HTTP-level errors (the user's action is the
  // truth); a fired limiter is its own story; everything else keeps its own message.
  const failure = (fallback) => {
    if (signal?.aborted && !limiter.aborted) return new SearchError("Search cancelled.", 499);
    if (limiter.aborted) return new SearchError("Jev took too long — try again.", 502);
    if (signal?.aborted) return new SearchError("Search cancelled.", 499);
    return new SearchError(fallback, 502);
  };
  let res;
  try {
    res = await fetchImpl(config.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: anySignal,
    });
  } catch (e) {
    throw failure(e?.name === "TimeoutError" ? "Jev took too long — try again." : "Could not reach Jev — check the connection.");
  }
  let text;
  try {
    text = await res.text();
  } catch {
    throw failure("Jev's reply was cut off — try again.");
  }
  if (!res.ok) {
    // Say what the upstream actually said. A 429 with retry-after is a quota window,
    // not a mystery — "try again in a moment" would be a lie the user can't act on.
    if (res.status === 429) {
      const wait = Number(res.headers?.get?.("retry-after"));
      const mins = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait / 60) : 0;
      throw failure(
        mins
          ? `Jev's free route is rate-limited — about ${mins} minute${mins === 1 ? "" : "s"} to go.`
          : "Jev's free route is rate-limited — try again in a few minutes.",
      );
    }
    // The model's own input cap: {"detail":{"error_type":"max_tokens_exceeded"}}.
    // The engine sizes chunks under it and halves on this exact answer, so it only
    // surfaces when one passage alone is too big — an honest 413, never a fake 502.
    const kind = upstreamErrorType(text);
    if (kind === "max_tokens_exceeded") {
      if (signal?.aborted) throw new SearchError("Search cancelled.", 499); // a cancel outranks any HTTP answer
      throw new SearchError("This passage is too big for the model on its own — try a smaller scope.", 413);
    }
    throw failure(`Jev answered HTTP ${res.status}${kind ? ` (${kind})` : ""} — try again in a moment.`);
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    throw failure("Jev sent an unreadable reply.");
  }
}
