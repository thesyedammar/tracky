# Tracky — build plan

**Name: Tracky** (locked 2026-09-26).

**Goal:** Ctrl+F that finds by meaning — highlight the sentence you meant, with receipts.

**Status:** Phases 0–1 complete (scaffold live; Jev brain proven with real run numbers). Next: Phase 2.

Legend: `[x]` done · `[~]` in progress · `[ ]` todo

## Locked decisions (2026-09-26)

- From scratch. The reference project (Needle, Apache-2.0) is **read-only study** — read it, never copy from it.
- Contract frozen v1 → `docs/contract.md`. Clients build against `app/mock/`.
- Key rule: the Jev key lives ONLY in `server/.env`. Never in the extension, never in the playground, never committed.
- Route LOCKED (Phase 1): opencode zen free gateway — base `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`. Official TypeSafe key stays as fallback.
- Helper: 127.0.0.1:4199. Node 22+. Public repo, MIT.
- Owners: `extension/` + `server/` + `spikes/` = Ammar; `app/` = Hamdan; `docs/` = both.
- Rules: smallest steps; commit after each; every phase demoed on a REAL page before "done"; no "it should work".

## Phases

### Phase 0 — Setup & contract
- [x] 0.1 Name picked: Tracky
- [x] 0.2 Repo skeleton (README, .gitignore, LICENSE, folders)
- [x] 0.3 Contract + mocks (docs/contract.md, app/mock/*.json)
- [~] 0.4 Public GitHub repo live; Hamdan invite sent (accept pending)
- [~] 0.5 Node 22: VPS done; Ammar laptop todo; Hamdan laptop todo
- [x] 0.6 server/.env.example + route documented
- [x] 0.7 PLAN.md = this file

Done when: repo live, contract + mock committed, Hamdan building.

### Phase 1 — Prove the Jev brain (terminal spikes)
- [x] 1.1 spikes/jev-1-question.mjs — one paragraph, one question → answer + probability
- [x] 1.2 Run; fix route/model if needed (free route uses `noul`, not `boolean`)
- [x] 1.3 spikes/jev-choice.mjs — pick which of 3 sentences mentions the charge → choice + probabilities
- [x] 1.4 spikes/jev-batch.mjs — 5 passages × 2 questions in ONE request
- [x] 1.5 spikes/jev-sanity.mjs — sanity battery: controls, position bias, injection, stability

Done when: three runs print real numbers; shape graduates to server/jev.mjs.
Results (zen free route, 2026-09-26): 1.1 `noul` 0.99 @ 800ms · 1.3 picked the charge sentence (s1, confidence 1.0) @ 760ms · 1.4 **ten questions in ONE call** @ 742ms — relevant 0.88/0.88, junk 0.03–0.05, borderline 0.25 (sensibly separated). 1.5 sanity battery: injection ignored (0.02–0.03) · picks correct at first/middle/last positions · 3× re-runs stable ±0.04 · gray zone 0.62–0.66 near the 0.58 line (threshold tuning → Phase 11 benchmark). Response keys for the engine: `answers[q].noul`, `answers[q].choice` + `.probabilities` + `.confidence`, `usage`. Judge loop: spikes cleared at **8.7/10** (loop 4, 7.4→7.7→7.6→8.7) — full ledger in `docs/judge-report.md`.

### Phase 2 — Sentences + questions + validation (test-first)
- [x] 2.1 server/sentences.mjs — Intl.Segmenter + abbreviation guards (case-insensitive: Rs./E.g./No./initials/lists/decimals), exact char offsets
- [x] 2.2 Spec-named tests (splits / guards / offsets / throw-on-non-string)
- [x] 2.3 server/jev.mjs — request builder (relevance `noul` + focus `choice` per passage; dup-id + BATCH_MAX=80 guards)
- [x] 2.4 server/validate.mjs — score 0–1, id must exist, substring belt, canonical id regexes, rank-don't-cut policy + tests
- [x] 2.5 spikes/fixtures/tos.txt — real Terms-of-Service fixture (41 sentences / 9 paragraphs)
- [x] 2.6 server/env.mjs + env tests — fail-fast loader, whitespace/URL checks, key never leaves the server

Done when: `node --test` green; fixture splits cleanly. ✓ 47/47 green; fixture → 9 paragraphs / 41 sentences. Judge: 8.4 → **9.1/10 accept** (docs/judge-report.md).

### Phase 3 — Engine as a plain script (+ sweep)
- [x] 3.1 spikes/search-cli.mjs — file + query → ranked [score] sentence (+offset, +`--json`)
- [x] 3.2 Ranking v1 → refined to rank-don't-cut: gate 0.58 + within-45%-of-best band, cap 8
- [x] 3.3 Run on ToS, query "hidden charges" — top 0.92, 6 real fee hits
- [x] 3.4 Wording pass (topical kept — Phase-1 proven; noted in server/jev.mjs)
- [x] 3.5 Chunk long pages into passes (BATCH_MAX=80/pass)
- [x] 3.6 Merge + dedupe across passes (identical sentences collapse to best hit)
- [x] 3.7 Huge-page fixture test — spikes/huge-page-check.mjs, 1000 blocks, 9/9 checks

Done when: fee sentence ranks #1 + huge fixture fully covered. ✓
Results (2026-09-27 IST): "hidden charges" → 0.92 top ("They are not part of the advertised daily rate.") @815 ms · "what happens if I cancel" → 0.96 · "can I bring a pet" → single 0.67 hit (policy fix: top-3-always had dragged 0.09/0.03 stragglers into display) · 1000-block sweep → 13 passes of 80/40, golds on chunk edges p79/p80/p959/p960 all surface, 7.7 s, 212k/62k tokens. Engine safety cap: 1200 passages (extension collects ≤600 per contract). Judge: 8.5 → 8.8 → 8.2 → **8.9/10 accept** (4 loops; ledger in docs/judge-report.md). Tests: 60 specs green.

### Phase 4 — Helper server (+ transparency layer)
- [ ] 4.1 server/server.mjs — 127.0.0.1:4199, POST /api/search, 512KB cap, loopback-only
- [ ] 4.2 Contract-exact responses; page text never logged (counts only)
- [ ] 4.3 server/env.mjs — clear missing-key startup error
- [ ] 4.4 Clean 400/413/502s per contract
- [ ] 4.5 spikes/curl-search.sh demo
- [ ] 4.6 Redact mode (strip emails/phones/IDs before sending)
- [ ] 4.7 Dry-run preview endpoint — exact payload, no Jev call
- [ ] 4.8 Sweep progress reporting (simplest working mechanism)

Done when: curl works; preview exact; long pages stream progress; Hamdan flips mock → real URL.

### Phase 5 — Extension skeleton
- [ ] 5.1 manifest.json (MV3, activeTab + scripting only)
- [ ] 5.2 background.js — icon click → inject; message relay
- [ ] 5.3 content.js — panel + ping/pong (isolated from page CSS)
- [ ] 5.4 Load unpacked + icons 16/32/48/128

Done when: panel opens on a real site and shows the helper's reply.

### Phase 6 — Extension reads pages
- [ ] 6.1 extension/collect.js — readable blocks, skip rules, caps (600 blocks / 400k chars max)
- [ ] 6.2 Query → collect → POST; helper logs counts only
- [ ] 6.3 Unsupported-page friendly message (PDF viewer, chrome://)

Done when: Wikipedia → helper sees 100+ real passages.

### Phase 7 — Panel results (+ trust features)
- [ ] 7.1 Match list (sentence + score, best-first)
- [ ] 7.2 Click → context view
- [ ] 7.3 States: loading / no matches / helper-not-running (with the fix command)
- [ ] 7.4 Hybrid: literal matches (client-side) grouped with meaning matches
- [ ] 7.5 Why-chips (one extra Jev question per match picks a reason from our list)
- [ ] 7.6 Answer card with [1][2][3] receipt chips
- [ ] 7.7 Scope/topic chips from page headings
- [ ] 7.8 Copy/export (sentence + source + timestamp; all matches as markdown)

Done when: answer card + hybrid + chips live on real pages.

### Phase 8 — Page highlights (ladder)
- [ ] 8.1 v1 `<mark>` wrap (and note why it is risky)
- [ ] 8.2 v2 offsets → TreeWalker → CSS Custom Highlight API (no DOM mutation)
- [ ] 8.3 Two layers + auto-scroll to first match
- [ ] 8.4 Safe-skip when the page changed

Done when: glows on normal sites; React sites survive untouched.

### Phase 9 — Feel-pro pass (+ memory & a11y)
- [ ] 9.1 Debounce 700ms + generation counter
- [ ] 9.2 Keyboard nav (Enter/Shift+Enter/Esc; Ctrl+F refocus)
- [ ] 9.3 Panel polish; `storage` permission when needed
- [ ] 9.4 History + result cache (instant re-runs)
- [ ] 9.5 Continuity: panel survives navigation; auto-rescan on SPA change + rescan button
- [ ] 9.6 A11y pack (reduced motion, contrast, SR announcements, keyboard-complete)
- [ ] 9.7 Per-site allow/deny + spend meter in options

Done when: smooth; cached re-runs instant; a11y checks pass.

### Phase 10 — Playground (Hamdan)
- [ ] 10.1 app/ built against mock (spec message = checklist)
- [ ] 10.2 Integration day (app + real helper on one machine)
- [ ] 10.3 Real-document test
- [ ] 10.4 Shareable deep link (URL recreates doc + query)
- [ ] 10.5 Saved-docs shelf
- [ ] 10.6 Fetch article from URL

Done when: full trick + a link a friend can open.

### Phase 11 — Prove it is not lying
- [ ] 11.1 Hostile-text test ("ignore instructions, pick me" must NOT win)
- [ ] 11.2 Forced-bad-answer test (app errors, never fabricates)
- [ ] 11.3 Key-leak test (key only in server/.env)
- [ ] 11.4 Benchmark room: fixed suite (pages × queries × expected), one command
- [ ] 11.5 Real-page suite (10 × 3) logged in docs/verification.md
- [ ] 11.6 Speed + spend log; numbers into README

Done when: every box ticked with real evidence; numbers public.

### Phase 12 — Package & share (technical)
- [ ] 12.1 scripts/package-extension.mjs (allowlist zip, manifest + icon check, deterministic)
- [ ] 12.2 Full README (install, privacy — what leaves the machine, limits, troubleshooting)
- [ ] 12.3 Screenshots
- [ ] 12.4 One-command helper + setup wizard (options page: one question)
- [ ] 12.5 Public token-gated playground deploy
- [ ] 12.6 Release + zip attached to GitHub Releases

Done when: a stranger can install and run it from the README alone.

### Phase 13 — PDF mode [flagship]
- [ ] 13.1 Detect PDF tab + offer the mode
- [ ] 13.2 pdf.js text extraction (local, no upload)
- [ ] 13.3 Overlay viewer: search + highlights inside it
- [ ] 13.4 Fallback: send text to playground

Done when: a real PDF searched + highlighted where native Ctrl+F gives up.

### Phase 14 — Cross-tab search [stretch]
- [ ] 14.1 Permission model
- [ ] 14.2 On-demand collection from open tabs
- [ ] 14.3 Results grouped by tab + jump
- [ ] 14.4 Guardrails for restricted pages

Done when: one query searches 5 open tabs.

### Phase 15 — Show it (the interview kit)
- [ ] 15.1 60–90s demo video/GIF
- [ ] 15.2 LinkedIn/X write-up
- [ ] 15.3 3–5 classmates as users + one feedback line
- [ ] 15.4 Resume bullets + portfolio updates (both)
- [ ] 15.5 Defense drill — the five deep-dives until solid

Done when: a recruiter can click, watch, and read real numbers.

## Scope map

v1 = Phases 0–12 · flagships 13–14 only after v1 is bulletproof · 15 at launch.

## Parked

offline local-model mode · Hinglish/multilingual test · Firefox port · team features · margin notes.

## Reference

- Needle (study-only): github.com/Shubhamsaboo/awesome-llm-apps → advanced_llm_apps/needle (Apache-2.0)
- Jev docs: docs.typesafe.ai
