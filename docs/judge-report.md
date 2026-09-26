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
