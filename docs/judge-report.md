# Judge report — Muse Spark verdicts

Every artifact of Tracky passes through an independent judge: **Muse Spark 1.3 (contributor)**, a Meta multimodal reasoning model, run via the opencode zen/go endpoint. The judge scores 1–10 on five axes and this file is the public ledger.

**Bands:** below 8 = needs improvement · 8.0–8.5 = good, not yet a pass · **above 8.5 = accept** (the bar for every artifact).

### Phase 1 — Jev brain spikes (1.1–1.5) — 7.4/10 🔴
- 27 Sept 2026, 1:20 am IST · model `muse-spark-1.3-contributor` · type research-spikes · files: spikes/jev-1-question.mjs, spikes/jev-choice.mjs, spikes/jev-batch.mjs, spikes/jev-sanity.mjs
- correctness **7.2** · craft **7.8** · robustness **5.9** · performance **8.9** · polish **7.1**
- top fixes:
  - Unify contract: state.passages is array in 1.4/sanity-R1 but map in 1.3/sanity-R2, and answer field is probability vs noul vs confidence — one shape will fail live
  - Add fail-fast env validation and res.ok handling: 1.1/1.3 log error body as success, 1.4 ignores HTTP errors, sanity res.json() can throw unhandled
  - Add explicit pass/fail thresholds instead of eyeball logs: define high/low cutoffs for calibration and MUST-stay-low for injections
  - Remove dead weight: relevantInstructions(id,expect) ignores expect, pct() fallback stringifies whole object, filenames/numbering inconsistent
  - Extract shared askJev helper to remove copy-pasted fetch/timeout/log boilerplate across all four spikes

### Phase 1 — Jev brain spikes (loop 2) — 7.7/10 🔴
- 27 Sept 2026, 1:23 am IST · model `muse-spark-1.3-contributor` · type research-spikes · files: spikes/jev-1-question.mjs, spikes/jev-choice.mjs, spikes/jev-batch.mjs, spikes/jev-sanity.mjs, spikes/lib/jev.mjs
- correctness **7.4** · craft **8.2** · robustness **6.9** · performance **8.3** · polish **7.7**
- top fixes:
  - Make 1.1 and 1.3 self-asserting with PASS/FAIL exit codes and actually print per-option probabilities claimed in comment
  - Eliminate observation-only loopholes in sanity battery: assert p5/p6/g3 bounds or drop them, no eyeballing allowed
  - Harden lib/jev.mjs: robust .env parsing with quotes/comments, validate answer/choice shape, do not process.exit inside library
  - Tighten batch assertions: validate focus choice format/range for all passages and define expected behavior for low-relevance focuses
  - Fix stability design: pass temperature/seed, send only asserted ids on repeats, handle transient HTTP failures as test failures not die() with exit 1

### Phase 1 — Jev brain spikes (loop 3) — 7.6/10 🔴
- 27 Sept 2026, 1:26 am IST · model `muse-spark-1.3-contributor` · type research-spikes · files: spikes/jev-1-question.mjs, spikes/jev-choice.mjs, spikes/jev-batch.mjs, spikes/jev-sanity.mjs, spikes/lib/jev.mjs
- correctness **7.1** · craft **8** · robustness **7.4** · performance **9** · polish **7.6**
- top fixes:
  - Print per-option probabilities for every choice question: batch and sanity focus picks currently omit them while only jev-choice.mjs prints
  - Bound stability on all asserted ids: Round 4 only re-sends calibration set, g0-g3 and x0-x1 have no drift bound
  - Treat malformed contract as execution error: missing answers object or wrong shapes currently collapse to exit 2 instead of exit 1; validate schema
  - Fix ambiguous forced picks: batch p1 s0 vs s1 both mention charge, and sanity g3 forces a valid index when no fee exists which rewards hallucination
  - Remove dead weight and measurement nits: unused fmt export and BASE/MODEL return, ms excludes res.text/parse, localeCompare misorders s10 vs s2, raw probability formatting

### Phase 1 — Jev brain spikes (loop 4) — 8.7/10 🟢
- 27 Sept 2026, 1:29 am IST · model `muse-spark-1.3-contributor` · type research-spikes · files: spikes/jev-1-question.mjs, spikes/jev-choice.mjs, spikes/jev-batch.mjs, spikes/jev-sanity.mjs, spikes/lib/jev.mjs
- correctness **8.5** · craft **9** · robustness **8.2** · performance **9.2** · polish **8.8**
- top fixes:
  - Tighten choiceIndex to exact key match and assert probabilities completeness — s01/s00 currently accepted and missing probs prints ? yet still passes
  - Missing per-question answers treated as assertion fail exit 2 instead of contract exec error exit 1 — add must-have-keys guard
  - Harden loadEnv: silently ignores malformed lines, no export prefix or spaced KEY = value support, empty-string handling
  - Drift checks mask absent data with ??0/??1 and accept NaN/Infinity — explicitly require finite numbers
  - Fix polish nits: probsLine claims fixed-width but isn't, g3_rel key breaks key==passage-id convention used elsewhere

### Phase 2 — engine core (sentences + builder + validator + env) — 8.4/10 🟡
- 27 Sept 2026, 1:35 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/sentences.mjs, server/jev.mjs, server/validate.mjs, server/env.mjs, server/test/sentences.test.mjs, server/test/jev.test.mjs, server/test/validate.test.mjs
- correctness **8.4** · craft **8.8** · robustness **7.8** · performance **9** · polish **8.2**
- top fixes:
  - Make abbreviation masking case-insensitive and complete: E.g./RS./NO./Fig./a.m./p.m. currently split; INITIAL_RE + ABBREV_RE miss capitalized variants
  - Harden adjudication gate: validate passages array (else TypeError not 502), re-verify focusText is substring in rankResults, validate probabilities, reject p00/p01 leading-zero ids to match strict sN rule
  - Add missing server/test/env.test.mjs and fix parseEnv: inline trailing comments, whitespace-only quoted values treated as present, no URL validation
  - Guard builder against duplicate ids silently overwriting questions and unbounded 600-passage single request; document/enforce chunking
  - splitSentences returns [] for non-string hiding bugs and LIST_RE/decimal handling is narrow; throw on non-string and protect decimals like 3.14

### Phase 2 — engine core (loop 2) — 9.1/10 🟢
- 27 Sept 2026, 1:42 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/sentences.mjs, server/jev.mjs, server/validate.mjs, server/env.mjs, server/test/sentences.test.mjs, server/test/jev.test.mjs, server/test/validate.test.mjs, server/test/env.test.mjs
- correctness **9** · craft **9.2** · robustness **8.8** · performance **9.3** · polish **9**
- top fixes:
  - Mask all dots inside e.g./i.e./a.m./p.m. not just trailing dot; currently relies on Segmenter not splitting inner dot
  - Harden buildRequest to throw SearchError on unprepared passages and missing query/model instead of raw TypeError
  - Validate choice probabilities keys against criteria length, not just value ranges
  - Trim JEV_BASE_URL before new URL() check and return; consider restricting to http(s)
  - Clarify ofBest=0.55 naming (factor vs 45% drop) and guard sentinel collision if text contains \u0001

### Phase 3 — search engine + CLI + huge-page sweep — 8.5/10 🟡
- 27 Sept 2026, 1:48 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/search.mjs, server/validate.mjs, spikes/search-cli.mjs, spikes/huge-page-check.mjs, server/test/search.test.mjs, server/test/validate.test.mjs
- correctness **8.5** · craft **9** · robustness **8.5** · performance **9** · polish **8**
- top fixes:
  - CLI char offset is wrong on repeats: src.text.indexOf(sentence) returns first occurrence, not focusIndex occurrence — carry sentence offsets from preparePassages
  - CLI readFileSync outside try: missing/unreadable file throws raw stack instead of clean message/exit 1 — move inside try and handle loadEnv/file/empty-file uniformly
  - askJev cancel/timeout mapping is racy: signal?.aborted check shadows limiter timeout, and !res.ok / res.text paths ignore outer cancel — branch on signal reason and check cancel before HTTP error
  - huge-page-check overclaims boundaries and coverage: p500 is not an 80-block boundary (500%80=20) and only last progress is checked — assert stats.chunks===13, per-pass sizes, and consumed total
  - Unvalidated engine plumbing: timeoutMs NaN/0/negative and non-function fetchImpl throw raw RangeError/TypeError instead of SearchError — validate/coerce and map to 502/500

### Phase 3 — search engine (loop 2) — 8.8/10 🟢
- 27 Sept 2026, 1:53 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/search.mjs, server/validate.mjs, spikes/search-cli.mjs, spikes/huge-page-check.mjs, server/test/search.test.mjs, server/test/validate.test.mjs
- correctness **8.9** · craft **8.7** · robustness **8.6** · performance **9** · polish **8.8**
- top fixes:
  - make mapFailure control-flow explicit — call sites rely on side-effect throw with no return/throw, fragile and linter-hostile
  - require integer focusStart in belt — null coerces to 0 in slice and sentences.length 0 silently yields null focus instead of upstream 502
  - guard rank/signal/onProgress types — rank null, non-AbortSignal signal, or non-function onProgress throw raw TypeError not SearchError
  - huge-page-check hardcodes 80/40 instead of importing BATCH_MAX — drifts silently if batch size changes
  - CLI empty-file reports as cannot-read and cleanProbabilities accepts arrays — fix messages and reject array probabilities

### Phase 3 — search engine (loop 3, final) — 8.2/10 🟡
- 27 Sept 2026, 1:56 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/search.mjs, server/validate.mjs, spikes/search-cli.mjs, spikes/huge-page-check.mjs, server/test/search.test.mjs, server/test/validate.test.mjs
- correctness **7.8** · craft **8.6** · robustness **7.9** · performance **8.3** · polish **8.2**
- top fixes:
  - rank=null passes guard (rank != null) then crashes rankResults destructuring with TypeError, not clean 500; must reject null/arrays or default safely
  - rank fields minBest/ofBest/limit unvalidated: NaN/negative/huge values corrupt gating/band/cap, needs clean 500 validation
  - huge-page-check still hardcodes 80-assumption via goldAt 79/80/959/960 and stale 'Chunk size is 80' comment despite BATCH_MAX import; compute edges from BATCH_MAX
  - signal guard only checks addEventListener so any EventTarget passes; JSON-parse error bypasses failure()/abort mapping and should respect cancel/timeout
  - sentences.length===0 check placed after focus branches, p.text.includes redundant after slice equality, dedupe trims key but surfaces untrimmed sentence

### Phase 3 — search engine (loop 4, final) — 8.9/10 🟢
- 27 Sept 2026, 2:00 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/search.mjs, server/validate.mjs, spikes/search-cli.mjs, spikes/huge-page-check.mjs, server/test/search.test.mjs, server/test/validate.test.mjs
- correctness **9** · craft **9** · robustness **8.7** · performance **8.8** · polish **9**
- top fixes:
  - No signal.aborted pre-check between chunks — outer cancel arriving in merge window still fires the next Jev pass if fetchImpl ignores the signal
  - rankResults/dedupeResults assume array input — non-array parsed throws raw TypeError instead of clean SearchError 500
  - askJev exported directly without config/signal validation — missing baseUrl/model/apiKey or bad body yields TypeError, bypassing searchText guards
  - Strictly serial passes — 13-pass sweep pays full serial latency with per-chunk timeout only and no total budget or concurrency option
  - Minor dead weight: focusIndex===null branch unreachable, null-focus entries passed through dedupe only to be filtered at rank
