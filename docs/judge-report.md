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

### Phase 4 — helper server (contract, caps, redact, preview, SSE) — 8.4/10 🟡
- 27 Sept 2026, 2:07 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **7.9** · craft **8.7** · robustness **7.8** · performance **9** · polish **8.8**
- top fixes:
  - Implement spec 499 client-disconnect path: map AbortError to 499/log, guard SSE res.write after close, don't emit 500 on abort
  - Fix redact US-phone leak: only (XXX) XXX-XXXX is masked, bare 415-555-1234 / 415.555.1234 / 415 555 1234 leak to Jev; broaden and add tests
  - SSE early failures bypass events: validation/413 on ?stream=1 returns JSON after no open frame; send open first then error event or document contract
  - 413 declared-length fast path never destroys/drains req and loopback check lives only in CLI main, not createHelperServer; enforce on listen
  - Preview uses input.passages.length and double JSON.stringify for bytes; use prepared length and single serialization

### Phase 4 — helper server (loop 2) — 7.8/10 🔴
- 27 Sept 2026, 2:11 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **7.5** · craft **8** · robustness **7** · performance **8.5** · polish **8**
- top fixes:
  - Guard all SSE writes: onProgress res.write is unguarded and violates spec; check destroyed/headers and try/catch progress/result/error writes
  - Fix phone_us leading-paren: \b\(? fails before '(' leaving '(' unmasked; use lookbehind or (^|\D) capture so (415) form fully masked
  - Fix preview stats inconsistency: log uses prepared.length but stats uses input.passages.length; use prepared.length and reuse single serialization for bytes+response
  - Fix 499 path to attempt no response: currently calls res.end() even when destroyed/headers unsent which can send empty 200; destroy instead and skip end if destroyed
  - Add missing stream-error observability and harden readBody: log SSE error path like non-stream, avoid removeAllListeners side-effects, handle req error after destroy

### Phase 4 — helper server (loop 3) — 8.1/10 🟡
- 27 Sept 2026, 2:14 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **8** · craft **8.6** · robustness **7.7** · performance **9** · polish **8.3**
- top fixes:
  - SSE error path has no res.destroyed guard and open-frame write has no try/catch, contradicting every-write-guarded claim
  - Early client disconnect during readBody hangs: no req/res close handling before AbortController is created
  - phone_us misses separator-less 4155551234 and is blocked after ( e.g. ((415)...) due to (?<![\w(]), leaving PII unmasked
  - sendJson/writeHead touch socket without destroyed guard; will throw on raced disconnect
  - reject413 leaves end listener attached, pauses instead of draining, and req.destroy only on finish which never fires if client already gone

### Phase 4 — helper server (loop 4) — 8.4/10 🟡
- 27 Sept 2026, 2:20 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **8.4** · craft **8.9** · robustness **8.1** · performance **9** · polish **8.7**
- top fixes:
  - Result-path res.end() is only destroyed-checked, not try/catch — raced disconnect can still throw, breaking EVERY-write-guarded claim
  - No read timeout in readBody — trickling client can hold handler forever (slowloris DoS)
  - Early-413 res.once(finish)->destroy never fires if res already destroyed, leaving req paused; close listener handling asymmetric between early vs streaming 413
  - Redact gaps: ((415) 555-1234 leaves leading '(' unmasked; Rs./.-prefixed 10-digit (e.g. Rs.1234567890) bypasses phone_bare/long_number via (?<![\d.,₹])
  - Late-abort logs 200 while sendJson no-ops on destroyed socket; unexpected errors go to console.error bypassing injected log, breaking counts-only testability

### Phase 4 — helper server (loop 5) — 8.4/10 🟡
- 27 Sept 2026, 2:24 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **8.6** · craft **8.7** · robustness **7.9** · performance **9** · polish **8.3**
- top fixes:
  - Redact still uses \b / (?<![\w]) so letter-adjacent runs leak (e.g. a(415) 555-1234, abc1234567890, XABCDE1234F) — use digit-lookarounds for privacy-first masking
  - Unexpected-error log interpolates err.message verbatim which can carry page text/key — sanitize to name/code only to keep counts-only privacy
  - Startup/listening path uses console.error bypassing injected log, violating ALL-errors-through-log claim — inject log there too
  - Stream success logs 200 before write/end succeeds, so failed delivery still logs 200 — move log after confirmed flush or log 499 on write failure
  - Redact header still says conservative/rupees survive while code comment says over-mask even next to ₹ — reconcile docs and confirm Rs.5,000 vs Rs.1234567890 boundary

### Phase 4 — helper server (loop 6) — 9/10 🟢
- 27 Sept 2026, 2:28 am IST · model `muse-spark-1.3-contributor` · type production-code · files: server/server.mjs, server/redact.mjs, server/test/server.test.mjs, server/test/redact.test.mjs, spikes/curl-search.sh
- correctness **9** · craft **9.2** · robustness **8.7** · performance **9.1** · polish **9**
- top fixes:
  - Stream 499 path relies on sync try/catch around res.write; async EPIPE/flush failure still logs 200 — use write callback/error listener
  - Non-stream success logs 200 before sendJson, can log delivered 200 that was never flushed — log after write like stream
  - No res error listener and pipeline continues even if SSE open frame failed (res.destroyed) — early-exit to avoid wasted Jev call
  - PAN is uppercase-only and phone_intl lacks digit lookarounds, inconsistent with privacy-first glued-run claim
  - Stream vs non-stream log shapes differ ("(stream)" only on error) making 200s indistinguishable in ops

### Phase 5 — extension skeleton (MV3 panel + live ping/pong) — 8.4/10 🟡
- 27 Sept 2026, 2:35 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/manifest.json, extension/background.js, extension/content.js, scripts/make_icons.py, scripts/ext-smoke.py, spikes/ext-gesture-probe.py, spikes/fixtures/tos.html
- correctness **8.7** · craft **8.2** · robustness **7.9** · performance **9** · polish **8.4**
- top fixes:
  - Make scripts/ext-smoke.py and probe portable: remove hardcoded /root/.cache/ms-playwright path, discover Chrome via env/playwright, use temp profile, replace fixed sleeps with waits
  - Validate helper health payload shape in background and content: never render helper undefined · undefined · ready which currently still passes smoke substring checks
  - Isolate host element itself: inline all:initial and containment on #tracky-root so page CSS cannot hide/clobber it, otherwise shadow-DOM never-leak claim is false
  - Fix service-worker badge clear: setTimeout may never fire after suspend; use distinct colors for × vs ! and clear reliably
  - Single-source VERSION and harden dialog: focus trap/return-focus, aria-modal, avoid duplicate ping on second inject where executeScript early-return plus tracky:open both fire

### Phase 5 — extension skeleton (loop 2) — 8.4/10 🟡
- 27 Sept 2026, 2:38 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/manifest.json, extension/background.js, extension/content.js, scripts/ext-smoke.py, scripts/make_icons.py, spikes/ext-gesture-probe.py
- correctness **8.3** · craft **8.2** · robustness **8.1** · performance **9** · polish **8.7**
- top fixes:
  - Focus restore broken on first open: lastFocus only captured when !visible, so first inject never remembers prior focus — capture activeElement before first input.focus()
  - Manifest missing host_permissions for http://127.0.0.1:4199 — background fetch relies on implicit permission; declare it or health fails on strict builds
  - Shiped probe is non-portable dead weight: hardcoded /root/.cache path, persistent profile, headless=False plus --headless=new — remove or port it
  - Badge flash timer race: setTimeout unconditional clear can wipe later state; store timer id and cancel on successful open
  - Smoke/shadow brittleness: locator '#tracky-root >> #t-status' does not reliably pierce shadow root, title_hint truncation and remaining fixed sleeps, plus isUnsupported misses file:// — fix query via shadowRoot evaluate and classify non-scriptable URLs as ×

### Phase 5 — extension skeleton (loop 3) — 8.2/10 🟡
- 27 Sept 2026, 2:40 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/manifest.json, extension/background.js, extension/content.js, scripts/ext-smoke.py, scripts/make_icons.py
- correctness **7.6** · craft **8.7** · robustness **7.9** · performance **9** · polish **8.6**
- top fixes:
  - First injection bypasses open(): bottom ping()+input.focus() never saves lastFocus, so Esc after first open cannot restore focus — route initial show through open() or capture activeElement before focus
  - Badge flash race remains: clearTimeout happens before awaits, two overlapping flash() can both set timers and leave dangling timeout — use generation token or clear after await
  - Re-injection double-open: content.js early-return calls open() and background then sends tracky:open causing second open()/ping — skip message if already present or make open idempotent
  - Smoke gaps: hardcoded jev-1.13-free model string, no file:// -> badge x coverage claimed, second press_shortcut return ignored
  - send() Promise.race timeout leaves dangling sendMessage promise to reject unhandled — attach catch/noop to loser branch

### Phase 5 — extension skeleton (loop 4) — 8.7/10 🟢
- 27 Sept 2026, 2:44 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/manifest.json, extension/background.js, extension/content.js, scripts/ext-smoke.py, scripts/make_icons.py
- correctness **8.7** · craft **9** · robustness **8.2** · performance **8.9** · polish **8.6**
- top fixes:
  - Scope Esc handler to panel focus instead of global capture + stopPropagation that hijacks page dialogs/fullscreen
  - Handle re-inject after worker reload: check for existing #tracky-root and add tabs.onRemoved cleanup; clearBadge never deletes state and leaves badge color
  - Make smoke crash-safe: wrap live health urlopen in try/fail check and use try/finally for ctx/httpd/profile cleanup; check file:// gesture return
  - Clear send() timeout on settle to avoid dangling 3s timer per ping
  - Reset pinging suppression correctly for close/open during in-flight ping and clear badge background color on success

### Phase 6 — extension reads pages (collector + live search) — 8.2/10 🟡
- 27 Sept 2026, 2:52 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/collect.js, extension/background.js, extension/content.js, scripts/ext-smoke.py, spikes/collect-debug.py
- correctness **8.4** · craft **8.7** · robustness **7.9** · performance **7.6** · polish **8.6**
- top fixes:
  - Remove querySelector(BLOCK_SELECTOR) per DIV/SPAN inside acceptNode — O(N^2) on large pages; precompute block set or propagate has-block-descendant flag during walk
  - Validate helper results shape before render — missing/non-numeric score/offset/sentence currently yields NaN% or TypeError mapped to misleading HELP_FIX
  - Filter nested SKIP_STRUCT/roles/aria-hidden/hidden children in extractText and enforce caps strictly + trim passages; container check must ignore invisible/skipped blocks
  - Unify Chrome discovery and fail-fast: collect-debug.py IndexErrors with no binary and ignores TRACKY_CHROME; ext-smoke default MIN_PASSAGES=8 does not enforce 100+ passage bar
  - Fix status semantics: zero matches uses pulsing wait dot, 502 mapped to not-helperDown, and ms falls back to 0 ms when stats missing

### Phase 6 — extension reads pages (loop 2) — 8.7/10 🟢
- 27 Sept 2026, 2:55 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/collect.js, extension/background.js, extension/content.js, scripts/ext-smoke.py, spikes/collect-debug.py
- correctness **8.6** · craft **8.8** · robustness **8.2** · performance **9.1** · polish **8.9**
- top fixes:
  - Unify validation: runSearch counts with sentence-only filter while renderResults requires finite score, so count can disagree with rendered hits; also Number.isFinite(r.offset) rejects numeric-string offsets that should coerce via Number(r.offset), and esc(r.passageId) renders "undefined" when missing
  - Clip divergence: text clipped to 20k chars but registry keeps full-length segments, so future highlight offsets can exceed clipped text — clip segments or store unclipped length explicitly
  - Collector throw misclassified: exception from window.__trackyCollect() falls into generic catch that shows HELP_FIX helper-not-running instead of a reader-failed message
  - hasDirectLongText never early-exits and allocates trim() per text node; SKIP_TAGS check is uppercase-only so lowercase svg tagName can leak SVG text
  - Gray zero uses implicit setStatus("",...) relying on default .dot; add explicit neutral class instead of empty-string kind

## Phase 6 — extension reads pages (collector + live search)

| loop | score | verdict | what changed |
|---|---|---|---|
| 1 | 8.2 🟡 | good | first pass: TreeWalker collector, search relay, live smoke against helper |
| 2 | **8.7 🟢** | **accept** | container-fallback cost reordered (measured 4–7 ms/article), results sanitized before render, nested skip-rules in extraction + exact trimmed segment map, harness defaults (100 passages on real sites), honest status semantics (idle dot for zero matches, structured HTTP ≠ helper-down, client-duration fallback) |

Evidence: 107 blocks / 34.9k chars @7 ms (en.wikipedia.org/wiki/Lease) · smoke 20/20 on the fixture AND on Lease — helper saw **107 passages**, matches rendered, first match a real escrow-deposit sentence @1.4 s · screenshot visually verified. Advisories from the accept folded in the same commit (unified sanitizeResults, clipped segment map, collector-throw message, early-exit container test, lowercase-SVG tag guard, explicit `.dot.idle`).

### Phase 7 — panel results + receipts (click-to-jump, highlight, copy) — 8.3/10 🟡
- 27 Sept 2026, 3:03 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, scripts/ext-smoke.py
- correctness **8** · craft **8.6** · robustness **7.8** · performance **8.9** · polish **8.4**
- top fixes:
  - Keyboard accessibility hijacked: Enter/Space on focused copy button triggers jumpTo instead of copy due to resultsEl keydown + preventDefault; no visible rank despite spec requiring rank/score/sentence/copy
  - Dishonest success when locate fails: range null or detached block.element still flashes and reports 'showing that sentence'; need isConnected check on block.element and distinct failure status
  - Stale status revert race: showStatusBriefly timer not cleared on new runSearch, can overwrite reading/searching status with old statsLine
  - Scroll correction math wrong for tall blocks and inner scrollers: scrollBy(delta) overshoots by (elH-rectH)/2 and uses window.scrollBy only, so inner-container sentences are not centered
  - rangeFor synthetic-gap fallback collapses to zero-length at next segment start and sanitizeResults allows empty passageId; map gap to inter-segment boundary and filter empty IDs

### Phase 7 — panel results + receipts (loop 2) — 8.1/10 🟡
- 27 Sept 2026, 3:05 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, scripts/ext-smoke.py
- correctness **8.1** · craft **7.9** · robustness **8** · performance **8.3** · polish **8.4**
- top fixes:
  - Cache collected blocks explicitly in content.js instead of relying on window.__trackyBlocks side-effect from __trackyCollect(); jumpTo otherwise always fails if collector does not set it
  - Remove dead `rect = range.getBoundingClientRect()` (unused forced layout) and treat `range.collapsed` / zero-height as null so collapsed range uses 'showing the paragraph — that sentence couldn't be marked' instead of claiming success
  - Clear statusTimer on close() and guard empty-query ping during active search; otherwise a pending briefly-revert can overwrite fresh ping/search progress after reopen
  - Fix innerScroller() boundary: loop stops at document.body, misses body/html/overlay scrollers; verify window vs container delta in both cases
  - Extend ext-smoke.py beyond 23 generic checks to assert loop-2 receipts: rank 1..N, Enter/Space on .copy never calls jumpTo, detached/null-range messages, gap mapping non-collapse

### Phase 7 — panel results + receipts (loop 3) — 8.3/10 🟡
- 27 Sept 2026, 3:08 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/collect.js, scripts/ext-smoke.py
- correctness **7.8** · craft **9** · robustness **8.3** · performance **9** · polish **8.7**
- top fixes:
  - trimmedView rebases start/end but not node offset: pos 0 in a leading-trimmed text node maps to offset 0 instead of trim amount, shifting highlight start; store node base offset and add it in locate
  - jumpTo still falls back to window.__trackyBlocks.get — reintroduces the side-effect dependency the spec removed; use lastById only and report honest missing-page message otherwise
  - marked stays true when CSS.highlights.set throws on older engines, then claims 'showing that sentence' with no mark; only set marked after successful set
  - first search types without focus/select assert and lastFocus can capture host via activeElement retargeting; select input before typing and ignore host when capturing lastFocus
  - sanitizeResults does not range-check score so Math.round(score*100)% can render >100% or negative; clamp to 0-100

### Phase 7 — panel results + receipts (loop 4) — 9/10 🟢
- 27 Sept 2026, 3:12 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/collect.js, scripts/ext-smoke.py, spikes/fixtures/tos.html
- correctness **9.3** · craft **9** · robustness **8.8** · performance **9.1** · polish **9**
- top fixes:
  - Cap rendered results and sentence length in renderResults/sanitizeResults so a rogue helper cannot bloat panel DOM
  - Handle CSP-blocked page <style> for ::highlight: detect adopted failure and fall back to honest unmarked message
  - Remove or document dead prev!==input guard in open() since shadow retargeting makes activeElement never equal input
  - Avoid leaving window.__trackyBlocks as mutable global or freeze/document it as debug-only contract
  - Guard copy fallback against missing document.body and prefer navigator.clipboard path with clearer blocked messaging

### Phase 7 — panel results + trust features (full spec: card, hybrid, chips, scope, export) — 8.6/10 🟢
- 27 Sept 2026, 3:25 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/collect.js, extension/background.js, server/why.mjs, server/server.mjs, server/test/why.test.mjs, scripts/ext-smoke.py, docs/contract.md
- correctness **8.4** · craft **8.9** · robustness **8.3** · performance **8.6** · polish **8.8**
- top fixes:
  - Add generation token to loadWhy: stale why response can attach old reasons to new p0/p1 ids after a quick re-search; ignore superseded replies
  - Fix runSearch searching guard dropping input: rapid scope-click + Enter silently ignored; queue latest or disable input while searching
  - Remove/harden arbitrary caps: literalMatches break at 4 and scope row slice 0,6 hide real sections; document or paginate instead
  - Fix nested interactive: button.copy inside div[role=button] is invalid a11y; use article/row with separate jump button and copy button
  - Make panel send() timeout abort background work: currently timeout rejects but fetch to helper keeps burning; wire AbortSignal through

### Phase 9 — feel-pro pass (live search, cache, history, continuity, a11y, options) — 8.3/10 🟡
- 27 Sept 2026, 3:36 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/background.js, extension/manifest.json, extension/options.html, extension/options.js, scripts/ext-smoke.py, spikes/ctrlf-debug.py
- correctness **7.9** · craft **9.1** · robustness **8.6** · performance **9** · polish **8.3**
- top fixes:
  - Make answer-card receipt chips real <button>s with keyboard access; honor prefers-reduced-motion for the smooth correction scrollBy (use auto) not just CSS pulse/transitions
  - Include page-signature in lastSearchKey deduplication or clear it on content change — same query after in-place DOM change is currently dropped and can suppress a fresh answer
  - Show recent-query chips after a single search and include most-recent; current hidden-if-1 + slice(1) contradicts claimed evidence and hides the last question when field is empty
  - Broaden Esc close beyond activeElement===host check and make deny-list match subdomains/consistent normalization between background and content script
  - Ensure focus-visible and keyboard reachability for all interactive elements (card chips currently spans with no tabindex) and verify cached path still announces/pushes consistently

### Phase 9 — feel-pro pass (loop 2) — 7.9/10 🔴
- 27 Sept 2026, 3:39 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/background.js, scripts/ext-smoke.py
- correctness **6.9** · craft **8.6** · robustness **7.4** · performance **8.7** · polish **8.5**
- top fixes:
  - Background disabledFor uses exact host=== comparison, not hostMatches subdomain logic — spec requires hostMatches in injection gate; sub.example.com bypasses block
  - Dedupe quickKey omits location.href so two different pages with same query+sig can suppress a fresh answer; include href
  - hostMatches does not lowercase hostname argument, only list entry; normalize both and share one helper between content.js and background.js
  - Esc gate adds select beyond spec input/textarea/contenteditable without comment; align or document
  - Duplicated prefers-reduced-motion block for .dot.wait; consolidate

### Phase 9 — feel-pro pass (loop 3) — 7.9/10 🔴
- 27 Sept 2026, 3:41 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/shared.js, extension/background.js, extension/content.js, scripts/ext-smoke.py
- correctness **8** · craft **7.5** · robustness **8** · performance **8.5** · polish **7.5**
- top fixes:
  - Reduced-motion not actually consolidated: still two @media blocks while comment claims One block — merge .panel animation into the single block
  - key and quickKey are byte-identical definitions side-by-side with confusing comments — keep one canonical makeKey()
  - Page signature is only blocks.length:chars and collides on same-size different content — use content hash
  - hostMatches does not strip leading-dot entries or trailing-dot FQDN, and only SW copy is unit-tested so mirror can drift untested
  - Stale copy: (never sent to Jev) typo and misleading sync comments need cleanup

### Phase 9 — feel-pro pass (loop 4) — 7.6/10 🔴
- 27 Sept 2026, 3:44 am IST · model `muse-spark-1.3-contributor` · type production-code · files: extension/content.js, extension/collect.js, extension/shared.js, extension/background.js, scripts/ext-smoke.py
- correctness **7** · craft **7** · robustness **8** · performance **9** · polish **7**
- top fixes:
  - Delete the stray `@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }` after @keyframes tIn — spec requires ONE block and the separate .panel block gone; unified !important block already covers .panel/.dot.wait + .hit/.wrap/.dot/.jump/.recent-chip/.chip
  - Fix false `The one and only reduced-motion block` comment which is currently untrue while two blocks exist
  - Close storage race: open() runs before async trackyOpts load, so first-open deny check can use empty defaults — gate initial open/ping on opts load or re-check after load

### Phase 13 — PDF mode (reader, contract reuse, lazy canvases) — 7.6/10 🔴
- 27 Sept 2026, 4:30 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, scripts/pdf-smoke.py
- correctness **7.4** · craft **8** · robustness **6.8** · performance **8.2** · polish **8.1**
- top fixes:
  - Missing detect-a-PDF-tab-and-offer-mode code in artifact and no end-to-end search proof; smoke paints highlight manually instead of driving reused panel highlight/scroll path
  - Slide-aside is race-prone: observer attached only if tracky-root shadowRoot already exists, watches only style display and hard-codes 392px padding instead of measuring panel
  - Block builder merges multi-column layouts and mangles word breaks: gap uses only top delta with 1.9x rule, always joins spans with single space and normalizes spaces away in verification
  - Unsafe and fragile IO: fail() uses innerHTML with error text, fetch(src) has no URL validation or CORS fallback for cross-origin/file PDFs, paint() promises fire-and-forget with retained page objects and no rejection handling
  - Contract placeholders and dead paths: stats hash/ms/skipped faked as 0, MAX_BLOCK_CHARS clipping unreachable due to 1400-char flush, element points at first span not scrollable block, no password/rotation/mixed-size/very-large-doc handling

### Phase 13 — PDF mode (loop 2 after fixes) — 8.2/10 🟡
- 27 Sept 2026, 4:34 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, extension/background.js, extension/manifest.json, scripts/pdf-smoke.py
- correctness **7.9** · craft **8.4** · robustness **7.8** · performance **8.6** · polish **8.9**
- top fixes:
  - Detect extensionless PDFs (e.g. /pdf/1706.03762, content-type, blob:) — \.pdf regex misses common papers
  - Fix paragraph assembly: sort spans visually, correct column-jump direction, true de-hyphenation (drop soft hyphen, not keep trans-former)
  - Bound memory for large PDFs and handle paint failures — no size cap, unhandled paint() rejections, observer never disconnects
  - Make stats/stub contracts identical to collect.js (considered units, skippedDetail/pages/rendering, maxBlocks arg)
  - Harden panel-open detection — style.display + style-only observer misses class toggles and gives up silently after 10s

### Phase 13 — PDF mode (loop 3) — 7.6/10 🔴
- 27 Sept 2026, 4:41 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, extension/background.js, extension/manifest.json, scripts/pdf-smoke.py
- correctness **6.5** · craft **8.2** · robustness **7** · performance **8** · polish **8.3**
- top fixes:
  - Restore canvas pixel size on repaint: free() zeroes width/height but paint() never restores them, so re-armed pages repaint into a 0x0 canvas
  - Make pdf-stub.js stats match collect.js/pdf-viewer.js exactly: add skippedDetail (and spans) — stub currently omits them
  - Fix panel-open sync to honor class/hidden, not only wrap.style.display !== 'none', or class/hidden hides leave body.panel-open stuck
  - Truly de-hyphenate all line-break hyphens and fix column merging: lowercase-only guard keeps Trans-Former hyphenated, and same-y left/right lines are merged into one visual line before column detection
  - Harden page loop and thresholds: one buildPage/textLayer failure aborts whole doc, pageWidth heuristic and 0.18/2.5/1.9 constants are fragile, and observer attach gives up after 10s

### Phase 13 — PDF mode (loop 4) — 8.1/10 🟡
- 27 Sept 2026, 4:44 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, extension/background.js, extension/manifest.json, scripts/pdf-smoke.py
- correctness **7.4** · craft **8.7** · robustness **7.6** · performance **8.2** · polish **8.6**
- top fixes:
  - real stats omits `rendering` while stub has `rendering:true` — not byte-for-byte same keys; add `rendering:false` to real collector
  - only buildPage is try/caught; blocksFromPage throw still aborts whole document — wrap per-page collect and count pageErrors
  - de-hyphenation uses /^[A-Za-z]/ so accented/Unicode words (caf\u00e9- + x) miss spec's any-letter-case; use /^\p{L}/u
  - paint/free race: free can zero canvas mid-render and prune reflow is unbounded; guard in-flight paint and harden top/left parsing (empty style.top collapses to 0)
  - trustworthy-column fallback reverts to top-sorted runs which interleaves true two-column tail pages, and --panel-w goes stale when w<=100

### Phase 14 — cross-tab search (opt-in) — 7.6/10 🔴
- 27 Sept 2026, 4:45 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/background.js, extension/content.js, extension/options.js, extension/options.html, scripts/crosstab-smoke.py
- correctness **7.5** · craft **8.5** · robustness **7** · performance **7** · polish **8**
- top fixes:
  - Early-exit when budget is 0: perTab forces to 1 and injects/collects up to 6 tabs then discards everything via map.size>=budget
  - ID collision risk: merged ids use p+merged.length assuming dense local p0..pN-1, breaks with scoped/filtered non-sequential ids
  - CROSS_TOTAL misapplied: used as per-tab cap via min(CROSS_TOTAL, budget/6) so total from other tabs can reach budget (~1200) exceeding stated 600 total cap
  - jumpToOtherTab has no try/catch around send() timeout, unhandled rejection; tracky:run handler not evidenced in provided content.js tail
  - Serial per-tab disabledFor storage read plus double executeScript; parallelize and pass perTab cap validation against collector maxBlocks support

### Phase 13 — PDF mode (loop 5) — 7.4/10 🔴
- 27 Sept 2026, 4:53 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, extension/background.js, extension/manifest.json, scripts/pdf-smoke.py
- correctness **6** · craft **8** · robustness **7** · performance **8** · polish **8**
- top fixes:
  - Column tracking increments on every left->right jump and never resets, so a 2-column page becomes 0,1,1,2,2,3... and sorted columns mix left+right; cluster by x instead and break on right->left transitions, otherwise untrustworthy mode still merges band1-right+band2-left into one block
  - offsetLeft/offsetTop fallback uses offsetParent coordinates while style left/top use textLayer coordinates, corrupting line grouping when styles are missing; use offset relative to textLayer or getBoundingClientRect delta
  - Failed paint deletes data-pending before render and first-two pages have no observer to retry, leaving a blank page forever; keep pending until success or re-arm observer on error
  - blocksFromPage is in a second try after pages.set and considered counting, not the same per-page try as buildPage; capped path counts only one overflow block and considered already includes failed pages
  - Real stats.maxBlocks is fixed at 600 while stub echoes the caller's maxBlocks, so identical calls report different stats values

### Phase 13 — PDF mode (loop 6) — 7.6/10 🔴
- 27 Sept 2026, 4:57 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/pdf-viewer.js, extension/pdf.html, extension/pdf-stub.js, extension/background.js, extension/manifest.json, scripts/pdf-smoke.py
- correctness **7** · craft **8** · robustness **8** · performance **7** · polish **8**
- top fixes:
  - Column trust guard exempts col 0 (c===0 || count>=2) contradicting every-cluster comment — single centered heading becomes a trusted column; require all clusters >=2
  - Sliced collect returns cap-limited blocks but full-document stats.blocks/chars/hash, and stub does not clamp invalid maxBlocks like real collector — identical calls diverge and stats.blocks != blocks.length
  - getBoundingClientRect called for every span even when style.left/top present — O(N) forced layouts on thousand-span papers; only fallback when style missing
  - Capped accounting lost when cap already reached before page (blocksFromPage skipped) and spans/considered count unfiltered spans vs filtered items — skip counters undercount
  - Perpetual 2s sync interval + 3s re-attach loop does getComputedStyle/getBoundingClientRect forever; use MutationObserver/resize only with backoff

### Phase 14 — cross-tab search (loop 2) — 8.2/10 🟡
- 27 Sept 2026, 4:57 am IST · model `muse-spark-1.3-contributor` · type code · files: extension/background.js, extension/content.js, extension/options.js, extension/options.html, scripts/crosstab-smoke.py
- correctness **8** · craft **8.5** · robustness **7.5** · performance **9** · polish **8**
- top fixes:
  - Check budget<=0 before storage read — currently reads trackyOpts first, so not 'without reading anything'
  - Conflated skipped buckets: isUnsupported/isPdf counted as denied, over used for both too-many-tabs and budget-exhausted, off never used, skippedNote dropped when tabs empty
  - No timeout on collectFromTabs Promise.all — one hung executeScript hangs the whole search
  - No validation of other-tab blocks before merge — b.id/b.text unchecked, undefined text can be sent, colon-collision not excluded if local ids contain colon, outer HELPER_MAX break only breaks inner loop
  - xSearch default opts.crossTab !== false is true when undefined, inverting off-by-default in panel state
