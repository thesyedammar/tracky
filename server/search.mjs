// The search engine — one query over many passages: chunked Jev passes, merged,
// deduped, ranked. This is the module the helper (Phase 4) calls; the CLI
// (spikes/search-cli.mjs) exercises it today.
import { validateSearchInput, parseJevAnswers, rankResults, SearchError } from "./validate.mjs";
import { preparePassages, buildRequest, BATCH_MAX } from "./jev.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;

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
  const chunkCount = Math.ceil(prepared.length / BATCH_MAX);

  const started = performance.now();
  const usage = { input_tokens: 0, output_tokens: 0 };
  const consumed = [];
  for (let i = 0; i < prepared.length; i += BATCH_MAX) {
    if (signal?.aborted) throw new SearchError("Search cancelled.", 499); // cancelled during a previous pass
    const chunk = prepared.slice(i, i + BATCH_MAX);
    const body = buildRequest({ query: input.query, passages: chunk, model: config.model });
    const { data } = await askJev(body, { config, fetchImpl, timeoutMs, signal });
    usage.input_tokens += Number(data?.usage?.input_tokens) || 0;
    usage.output_tokens += Number(data?.usage?.output_tokens) || 0;
    consumed.push(...parseJevAnswers(data, chunk));
    onProgress?.({
      done: consumed.length,
      total: prepared.length,
      chunk: i / BATCH_MAX + 1,
      chunks: chunkCount,
    });
  }
  return {
    results: rankResults(dedupeResults(consumed), rank ?? {}),
    stats: { chunks: chunkCount, passages: prepared.length, ms: Math.round(performance.now() - started), usage },
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
  if (!res.ok) throw failure(`Jev answered HTTP ${res.status} — try again in a moment.`);
  try {
    return { data: JSON.parse(text) };
  } catch {
    throw failure("Jev sent an unreadable reply.");
  }
}
