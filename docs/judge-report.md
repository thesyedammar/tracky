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
