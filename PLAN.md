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
- [x] 4.1 server/server.mjs — 127.0.0.1:4199, POST /api/search, 512KB cap, loopback-only (+ listen-time guard)
- [x] 4.2 Contract-exact responses; page text never logged (counts only — proven by test)
- [x] 4.3 server/env.mjs — clear missing-key startup error
- [x] 4.4 Clean 400/413/502s per contract (+ 408 read timeout, 499 disconnects)
- [x] 4.5 spikes/curl-search.sh demo — health / preview / search / SSE, all green live
- [x] 4.6 Redact mode — same-length masking (emails/phones/PAN/digit runs; short money + dates survive)
- [x] 4.7 Dry-run preview endpoint — exact payload, no Jev call (`Bearer •••`, key never echoed)
- [x] 4.8 Sweep progress reporting — SSE (`event: open/progress/result/error`) + `?stream=1`

Done when: curl works; preview exact; long pages stream progress; Hamdan flips mock → real URL.

Results (2026-09-27 IST): helper live on 127.0.0.1:4199 — health OK · preview byte-exact (9 passages → 1 chunk · 10,672 B · **0 Jev calls**) · search "hidden charges" → 6 hits, top 0.92 @583 ms · SSE frames open→progress→result verified with curl · counts-only logs proven (page text never reaches the log) · redact same-length so offsets/highlights stay exact (bullets echo back) · 408 slowloris timeout, 499 disconnect path, loopback listen guard. Judge: 8.4 → 7.8 → 8.1 → 8.4 → 8.4 → **9.0/10 accept** (6 loops; ledger in docs/judge-report.md). Tests: **83 specs green**.

### Phase 5 — Extension skeleton
- [x] 5.1 manifest.json (MV3, activeTab + scripting only; `_execute_action` bound to Alt+K so icon + shortcut are one path)
- [x] 5.2 background.js — icon click → inject; message relay (the only component that talks to the helper)
- [x] 5.3 content.js — shadow-DOM panel + ping/pong (isolated from page CSS both ways)
- [x] 5.4 Load unpacked + icons 16/32/48/128 (scripts/make_icons.py)

Done when: panel opens on a real site and shows the helper's reply.

Results (2026-09-27 IST): real-gesture proof — Chrome headed in Xvfb, xdotool presses the actual Alt+K at OS level (this is what grants activeTab; a programmatic inject was correctly refused by Chrome first — probe proved synthetic keys can't trigger accelerators, harness rebuilt to use the real gesture). **15/15 checks green twice: local fixture AND en.wikipedia.org** — panel injected + visible, shows the live helper reply `helper 0.4.0 · jev-1.13-free · ready` (asserted against the helper's own /api/health payload), Esc closes, second gesture reopens, file:// shows the × badge and injects nothing. Screenshots visually verified (dark glass panel, legible over dark + light pages, no clipping). Judge: 8.4 → 8.4 → 8.2 → **8.7/10 accept** (4 loops; ledger in docs/judge-report.md).

### Phase 6 — Extension reads pages
- [x] 6.1 `extension/collect.js` — readable blocks, skip rules, caps (600 blocks / 400k chars / 20k per block / 40-char min), trim + dedupe
- [x] 6.2 Query → collect → POST; helper logs counts only
- [x] 6.3 Unsupported-page friendly message (PDF viewer, chrome://) — tooltip + × badge

Done when: Wikipedia → helper sees 100+ real passages. ✅ **107 passages** (`/wiki/Lease`), 2–3 matches @1.4 s · fixture 9 passages → 6 matches @723 ms · smoke 20/20 both targets · judge 8.2 → **8.7/10 accept**

### Phase 7 — Panel results (+ trust features)
- [x] 7.1 Match list (sentence + score, best-first)
- [x] 7.2 Click → context view
- [x] 7.3 States: loading / no matches / helper-not-running (with the fix command)
- [x] 7.4 Hybrid: literal matches (client-side) grouped with meaning matches
- [x] 7.5 Why-chips (one extra Jev question per match picks a reason from our list)
- [x] 7.6 Answer card with [1][2][3] receipt chips
- [x] 7.7 Scope/topic chips from page headings
- [x] 7.8 Copy/export (sentence + source + timestamp; all matches as markdown)

Done when: answer card + hybrid + chips live on real pages. ✅ judge 8.6 · smoke 35/35 × 2 targets

### Phase 8 — Page highlights (ladder)
- [x] 8.1 v1 `<mark>` wrap — **skipped on purpose**: wrapping mutates the page's DOM, which
      fights React/Vue reconciliation and can break layout. We went straight to 8.2, which
      has no such risk, and proved it (react-survival.py: 0 nodes added/removed inside a live
      React root).
- [x] 8.2 v2 offsets → TreeWalker → CSS Custom Highlight API (no DOM mutation)
- [x] 8.3 Two layers + auto-scroll to first match — layers = persistent highlight + a short
      flash; the scroll happens when the user picks a result (moving the viewport unasked is
      hostile), landing the block instantly then nudging to the sentence.
- [x] 8.4 Safe-skip when the page changed (isConnected guards, collapsed-range rejection,
      honest "no longer on this page" message)

Done when: glows on normal sites; React sites survive untouched. ✅ 9/9 react-survival.py

### Phase 9 — Feel-pro pass (+ memory & a11y)
- [x] 9.1 Debounce 700ms + generation counter (live search; Enter cancels the timer)
- [x] 9.2 Keyboard nav (Enter/Shift+Enter/Esc; Ctrl+F refocus; ↑↓ through results)
- [x] 9.3 Panel polish; `storage` permission when needed
- [x] 9.4 History + result cache (instant re-runs; keyed by href+scope+query+content hash)
- [x] 9.5 Continuity: panel survives navigation; auto-rescan on SPA change + rescan button
- [x] 9.6 A11y pack (reduced motion, focus-visible, SR announcements, keyboard-complete)
- [x] 9.7 Per-site allow/deny + spend meter in options (deny list enforced before injection)

Done when: smooth; cached re-runs instant; a11y checks pass. ✅ smoke 46/46 × 2 targets
(judge loop: 8.3 → 7.9 → 7.9 → 7.6, all findings fixed — final re-judge pending the Jev
free-route quota window, which returned `retry-after: 5975` during this loop)

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
- [x] 11.3 Key-leak test (key only in server/.env) — `scripts/key-leak-check.mjs`:
      working tree (36 text files), the packaged zip (decompressed and scanned) and all
      10 commits → zero hits; .env is 600 and gitignored
- [ ] 11.4 Benchmark room: fixed suite (pages × queries × expected), one command
- [ ] 11.5 Real-page suite (10 × 3) logged in docs/verification.md
- [ ] 11.6 Speed + spend log; numbers into README

Done when: every box ticked with real evidence; numbers public.

### Phase 12 — Package & share (technical)
- [x] 12.1 scripts/package-extension.mjs (allowlist zip, manifest + icon check, deterministic)
- [ ] 12.2 Full README (install, privacy — what leaves the machine, limits, troubleshooting)
- [ ] 12.3 Screenshots
- [ ] 12.4 One-command helper + setup wizard (options page: one question)
- [ ] 12.5 Public token-gated playground deploy
- [ ] 12.6 Release + zip attached to GitHub Releases

Done when: a stranger can install and run it from the README alone.

### Phase 13 — PDF mode [flagship]
- [x] 13.1 Detect PDF tab + offer the mode (icon click → origin permission asked inside the
      gesture → reader tab opens; file:// PDFs guided to "Allow access to file URLs")
- [x] 13.2 pdf.js text extraction (local, no upload) — pdf.js 4.10.38 bundled in
      extension/vendor/pdfjs (Apache-2.0, no remote code, isEvalSupported:false)
- [x] 13.3 Overlay viewer: search + highlights inside it — extension/pdf.html renders every
      page with a text layer, emits the SAME {blocks, stats, byId, sections} contract as
      collect.js, so content.js's panel is reused unchanged; sections are the PDF's pages;
      highlights paint through the Custom Highlight API on the PDF's own text; the document
      slides out from under the open panel and back
- [ ] 13.4 Fallback: send text to playground (waits on the playground)

Verified: scripts/pdf-smoke.py — **16/16** on a real 15-page PDF (arxiv 1706.03762):
15 canvases, 2490 text-layer spans, 38 blocks / 40,434 chars, every block rebuilt from its
own spans with 0 mismatches, panel live, slide-aside both ways, highlight painted, 0 JS errors.

Done when: a real PDF searched + highlighted where native Ctrl+F gives up.
→ rendering/extraction/highlighting done and proven; the *search* half of this line needs the
model route (rate-limited at the time of writing) — one live search on this PDF completes it.

### Phase 14 — Cross-tab search [stretch]
- [x] 14.1 Permission model — opt-in in the options page; turning it on requests exactly
      the origins open right now (from the click gesture), never `<all_urls>`
- [x] 14.2 On-demand collection from open tabs — background gathers collect.js + blocks
      only (no panel, no UI), merged into the SAME search request so ranking is global;
      local passage ids stay put and other tabs continue the sequence
- [x] 14.3 Results grouped by tab + jump — its own section, each quote labelled with the
      tab's title and host; clicking one brings that tab forward and runs the question
      there; the panel's "Other tabs" toggle appears only when the option is on
- [x] 14.4 Guardrails — 6 tabs max, 600 passages from other tabs, never past the helper's
      1,200 ceiling; denied hosts skipped; Chrome-restricted tabs counted; tabs without a
      granted origin are not even listed by Chrome, so they cannot be read by accident

Verified: scripts/crosstab-smoke.py — **11/11** in a real Chromium with a real Alt+K
gesture: off by default, un-granted tabs unreadable, granted tabs collected (2 tabs,
1 block each on the fixture), budgets honoured (budget 12 → perTab 2), denied host
skipped, toggle shows and hides with the option.

Done when: one query searches 5 open tabs.
→ the gathering, budgets and UI are proven; the merged *search* needs the model route
(rate-limited at the time of writing) — one live run completes this line.

### Phase 15 — Show it (the interview kit)
- [ ] 15.1 60–90s demo video/GIF — scripts/demo-record.py written and ready (records a
      real session: real page, real search, highlight, scope, PDF); runs when the route opens
- [x] 15.2 LinkedIn/X write-up — docs/launch-post.md (both versions, real numbers, notes)
- [ ] 15.3 3–5 classmates as users + one feedback line — needs people, not code
- [x] 15.4 Resume bullets + portfolio updates — docs/resume-bullets.md (two lengths,
      every number traceable to docs/performance.md)
- [x] 15.5 Defense drill — the five deep-dives answered in docs/resume-bullets.md,
      plus a 7-step demo script for the live interview

Done when: a recruiter can click, watch, and read real numbers.
→ everything that can be written is written; 15.1 needs a model window and 15.3 needs
the user's classmates.

### Phase 16 — Direct mode (0.7.0): paste your key, skip the helper [approved 27 Sep]
Plan of record: `docs/plan-direct-mode.md` (decisions locked with ʿAmmār — helper stays
the default, key in `chrome.storage.local` only, ships as 0.7.0, Web Store listing later).
- [x] 16.1 `extension/direct.js` — the helper's brain ported into the extension: splitter,
      request builder (`BATCH_MAX` 80), the zero-fabrication validator, rank/dedupe, the
      chip pass, and a one-call `testKey`. Same caps, same 502 semantics, same rule that
      the model only ever PICKS (an index, never prose). Not ported: SSE, abort, redact.
- [x] 16.2 `extension/direct.test.mjs` — 29 specs mirroring `server/test/*` (validation,
      adjudication, ranking, chunking, hostile text, why-pass, testKey). The port is
      load-bearing, so it is tested first: 29/29 green.
- [x] 16.3 `background.js` branches on `trackyOpts.mode` for search + why + health; the panel
      gets the helper's exact response shape, so `content.js` needed one branch (the status
      line, which now says `direct · <model> · ready` or names what is missing).
- [x] 16.4 Options page *Connect* section: mode switch (Local helper default), key field
      (`type=password`), the two-route picker, **Test key** (one real call, real ms), and
      honest copy on what is stored where. Direct mode marks the helper sections as not used.
- [x] 16.5 `manifest.json` 0.7.0 + `optional_host_permissions` for the route — requested only
      when Direct is picked; a fresh install still has zero host access (proven live).
- [x] 16.6 `scripts/direct-smoke.py` — live, two builds: the shipped one stops at the
      permission gate with the reason; the granted one takes the key through the real UI,
      tests it, and searches with **the helper process stopped** (port 4199 confirmed
      closed) → 7 matches · 465 ms, highlights painted, key absent from page/panel/options/
      console/storage-beyond-its-field. 33/33.
- [x] 16.7 Docs: README second setup path + honest limits, `docs/contract.md` direct-mode
      section, `scripts/verify-all.sh` includes the new tests + smoke.
- [ ] 16.8 Web Store listing update (screenshots + copy) — later, separate task, on his go.

Done when: a friend can install, paste a key, and search with no Node anywhere.
→ met and measured 27 Sep 2026 (33/33 live, helper stopped; 157 unit tests green).

## Scope map

v1 = Phases 0–12 · flagships 13–14 only after v1 is bulletproof · 15 at launch.

## Parked

offline local-model mode · Hinglish/multilingual test · Firefox port · team features · margin notes.

## Reference

- Needle (study-only): github.com/Shubhamsaboo/awesome-llm-apps → advanced_llm_apps/needle (Apache-2.0)
- Jev docs: docs.typesafe.ai
