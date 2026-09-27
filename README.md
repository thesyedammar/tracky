# Tracky — Ctrl+F that finds by meaning

> Type *"hidden charges"* on a page that never uses those words and Tracky highlights the sentence you actually meant — **with receipts**: the exact text, in its exact place, nothing invented.

**Status: every phase built and verified — Phases 0–15, plus direct mode (0.7.0).** The engine, the local helper, the extension (including PDF mode and opt-in cross-tab search) and the packaging are live and measured (numbers below). The React playground (`app/`) is Hamdan's. See `PLAN.md` for the phase list.

## The 60-second tour

1. Start the helper: `node server/server.mjs` — or just **double-click `start-tracky.bat`** (Windows) / **run `./start-tracky.sh`** (mac, Linux). It holds your key in `server/.env`.
2. Load the extension: `chrome://extensions` → *Developer mode* → *Load unpacked* → pick `extension/`.
3. Open any long page, press **Alt+K** (or **Ctrl+F**), type what you mean, press Enter.
4. The best sentence is quoted in the panel; click it and it scrolls to and glows on the page itself.
5. On a **PDF** tab, click the Tracky icon instead — Tracky's own reader opens (pdf.js, rendered locally) and the same search highlights sentences inside the document, where the browser's Ctrl+F gives up on anything but exact letters.

## Direct mode — no helper, no Node, no terminal (0.7.0)

For a friend's laptop, or the Web Store, step 1 above is the friction: they would have to install Node and run a server. Direct mode removes it — the extension can call Jev itself with a key **the user** pastes:

1. `chrome://extensions` → *Load unpacked* → pick `extension/` (or install from the store).
2. Open Tracky's **options** → *Connect* → pick **Direct** → paste your Jev key → **Test key** (one tiny real call; it shows the model and the round-trip time).
3. That's the whole setup. Everything else — the panel, the highlights, the receipts, the why-chips — works exactly as it does in helper mode.

The helper stays the default, and helper mode is unchanged. In direct mode the extension runs its **own port of the helper's brain** (`extension/direct.js`: the splitter, the request builder, the zero-fabrication validator, the ranker and the chip pass) with the same constants — so the no-fabrication guarantee holds in both modes, and `extension/direct.test.mjs` mirrors the server's own cases against the shipped copy. The key is stored in `chrome.storage.local` on that one machine, never synced, and never sent anywhere except the route you picked; nothing about it changes at install (the host permission is requested when you pick Direct, and a search without it fails with the reason).

## Why it is different

| | Browser Ctrl+F | "AI search" chatbots | Tracky |
| --- | --- | --- | --- |
| Finds by meaning | ✗ (letters only) | ✓ | ✓ |
| Shows where it is on the page | ✗ | ✗ | ✓ (highlights the exact sentence in place) |
| Can invent text | ✗ | often | **never** — every quote is an exact slice of the page |
| Where your page text goes | nowhere | a vendor's servers | **your own local helper**, or (direct mode) **straight from your browser to the route you picked** |

The trick that makes "never" real: the model is only allowed to **pick** from sentences that already exist on the page. Every pick is re-verified as an exact character slice before it is shown; anything that fails to verify fails the search loudly instead of guessing.

## Real numbers (measured, not estimated)

| What | Result |
| --- | --- |
| Local fixture (10 passages) | 6 matches · **723–736 ms** |
| `en.wikipedia.org/wiki/Lease` (106–107 passages) | 5 matches · **1.05–1.5 s** |
| Repeat question (cached) | instant, zero model calls |
| Scoped search (one section of a page) | 107 → 6 passages searched |
| Unit tests | **175/175** (`node --test server/test/*.test.mjs extension/direct.test.mjs`) |
| Extension smoke checks | **46/46** on the fixture **and** on Wikipedia |
| React survival (real React 18 app) | **9/9** — 0 nodes added/removed inside the app's root |
| Cross-tab search (live, opt-in) | **12/12** — a real search returned a hit from another tab, labelled *In your other tabs* |
| Direct mode (live, 0.7.0) | **43/43** — key pasted through the real options UI, Test key answered in **579–853 ms**, and a real search returned **7 matches · 465 ms with the helper process STOPPED** (port 4199 confirmed closed); a 107-passage Wikipedia sweep ran the same way (3 matches · 1.2 s); the shipped build without the host permission stops at the gate with the reason, an empty key fails as NO_KEY (400) and a bad one as 401 **with the status crossing the message channel**; the key appeared **nowhere** in the page, panel, options page, console or any zip |
| PDF mode (two real papers) | 15-page single-column + 16-page two-column (BERT): **34/34** checks · opens in **~1.8 s** · 2,490 spans → 39 passages · every block rebuilt from its own spans (0 mismatches) · **0** blocks stitch two columns · memory bounded (**2 of 16 canvases allocated, ~8 MB**, first page freed and repainted on return) |
| Hostile text (prompt-injection bait on the page) | **5/5** — the bait cannot inflate its own score |
| Benchmark through the real model | **8/8** cases · median **481 ms** |
| Real pages, live | 10 sites × 3 questions · **30 rows, 0 invariant violations** (`docs/verification.md`) |
| Full battery (`scripts/verify-all.sh`) | **13/13 with the model route live** — 0 failed, 0 blocked, 0 skipped |
| Key-leak audit | tree + zip + all 10 commits → **0 leaks** |
| Panel motion (measured, 0.7.3) | frame deltas sampled on the host page: panel open **median 16.7 ms, 0 frames > 50 ms**; a full real search incl. results render **0 frames > 50 ms** of 3,660 · loading shows skeleton rows + a progress bar driven by the engine's real passes (**\"pass 2 of 4\"**, verified live on the 58-page paper) |
| Reader reveal (0.7.3) | the first sheets are painted **before** the loading overlay lifts (`__trackyPdfReady` now means *you can read it*): at ready, 2/2 first canvases painted, **0.03 s** measured |
| Independent judge (Muse Spark 1.3) | every phase accepted, **8.6–9.1 / 10**; the two newest phases scored **9.1** (PDF) and **8.9** (cross-tab) after 5–12 fix rounds each (`docs/judge-report.md`) |

## What leaves your machine

- Page text goes **page → your local helper (127.0.0.1) → the model route in `server/.env`**. Nothing else sees it. The helper binds to loopback only. In **direct mode** there is no helper hop: the text goes from your browser straight to the route you picked, with the key you pasted.
- The helper logs **counts, never text** (passages in, matches out, milliseconds).
- The API key lives **only** in `server/.env` (chmod 600, gitignored). It is never sent to the extension, never logged, never committed — `scripts/key-leak-check.mjs` proves it across the working tree, the packaged zip and every commit.
- In **direct mode** your key lives in `chrome.storage.local` on that one machine — not synced, not shared with anyone else's install, never packaged (`scripts/package-extension.mjs` refuses to build a zip containing a key-shaped string; `scripts/direct-smoke.py` checks the key is absent from the page, the panel, the options page, the console and the storage dump beyond its own field).
- **Redact mode** masks phone numbers, emails, cards, PANs and similar PII with same-length `•` *before* the text leaves, so offsets and highlights still line up.
- **Per-site deny list** in the options page — listed sites never even get the panel injected.
- **Pick your Jev source** in the options page: whatever you configure in `server/.env` (`JEV_PROVIDERS`) shows up as a dropdown — opencode Zen's paid `jev-1.13`, its free-window `jev-1.13-free`, or your own TypeSafe key. The extension only ever sends the *id*; keys never leave the helper. A source with no key shows as "no key yet" and cannot be picked.
- A local **spend meter** counts searches and passages per day (IST). It is a counter, not a log.

## How it works

```
page → collect.js   readable blocks + exact char offsets (≤600 blocks, ≤400k chars)
     → content.js   shadow-DOM panel, scope chips from headings, cache + history
     → background.js  relay (the page never talks to the helper directly)
     → server/      one request per batch of 80 → validate → rank → results
     → content.js   answer card, hybrid exact-word group, why-chips, jump + highlight
```

- **Rank, don't cut:** a sanity gate (best score below 0.58 → show nothing) plus a band (everything within 45% of the best score, max 8). An honest empty beats a weak guess.
- **Highlighting** uses the CSS Custom Highlight API — it paints a range, it never wraps your text in `<mark>`, so React/Vue pages cannot be disturbed (proven).
- **Why-chips** are a second pass where the model may only pick one label from our fixed list of eight reasons — an invalid pick is dropped, never guessed.
- **Hybrid:** exact-word matches are computed locally and merged with meaning matches, deduped by sentence.
- **Loading is honest:** while a search runs the panel shows skeleton rows and a 3 px bar that fills with the engine's *real* pass progress (helper mode streams it over SSE, direct mode reports it in-process) — never a fake spinner. Motion is transform/opacity only, and `prefers-reduced-motion` keeps the cross-fades while removing movement and loops.

## Limits (the honest list)

- **Helper mode needs the helper running** — without it the panel says exactly that, with the command to fix it. **Direct mode needs no helper at all** (no Node, no terminal): it needs a key pasted in the options page, and the host permission Chrome asks for when you pick Direct.
- **Direct mode sends your key from that one browser.** It is stored in `chrome.storage.local`, tied to that browser profile — the same privilege level as any saved site login. Anyone who can read that profile can read it, so treat it like a password: a key you can rotate.
- **The direct route is a fixed pair.** The dropdown offers the two routes the helper ships with (`jev-1.13`, `jev-1.13-free`); if the provider renames a model, the extension needs an update. Helper mode has no such limit — `JEV_PROVIDERS` in `server/.env` is yours to edit.
- **The free model route rate-limits.** When it does, Tracky reports the real wait ("about 100 minutes to go") instead of pretending to search.
- **PDFs work now** — click the Tracky icon on a PDF tab and it opens Tracky's own reader
  (rendered locally with pdf.js, nothing uploaded) where a search highlights the sentence on
  the page itself. The first open of a long PDF takes a few seconds while it renders.
- **`file://` pages are not supported** except PDFs, which need Chrome's per-extension
  "Allow access to file URLs" toggle (the extension tells you when it is off).
- **Ctrl+F hijack needs one prior Alt+K on that tab.** The extension deliberately holds no `host_permissions`, so its panel can only exist where you opened it.
- **Very long pages cost more time** — one model request per 80 passages, run in sequence (a 1,000-passage page is ~13 passes).
- **A dense document is swept in several requests, not one big one.** The model takes at most 64k input
  tokens per request (measured against the real route, not guessed), so Tracky sizes every request by its
  real body size and, if the route still says "too big", halves the batch and retries. A 58-page academic
  paper used to fail with "HTTP 400" — it now finishes in ~4 passes. Prove any file end to end with
  `python3 scripts/huge-pdf-check.py <file.pdf> [--mode direct]`.
- **A paragraph longer than 2,200 characters is split at sentence ends**, not skipped: it becomes two or more passages (highlights still land on the right sentence). A 3,300-char paragraph on a real Wikipedia article used to fail the whole search — that is now a fixture in the test suite (`spikes/fixtures/long-paragraph.html`).
- **Scores are model opinions**, which is why they are shown as percentages and gated rather than trusted.
- The cache is per-tab and short-lived (10 minutes, 24 entries).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "helper not running — start it: node server/server.mjs" | Start the helper in a terminal; the panel re-checks on every open. |
| "direct mode — paste your key in Tracky's options" | Options → *Connect* → **Direct** → paste a Jev key → **Test key**. |
| "direct mode — allow access to opencode.ai in Tracky's options" | The origin permission is missing: Options → *Connect* → click **Direct** again and accept the prompt. |
| "Direct mode needs permission for opencode.ai — open Tracky's options and pick Direct again." | Same condition, seen on a search (the permission was revoked or never granted): re-pick **Direct** in *Connect*. |
| "Jev is answering slowly — search timed out before the whole page was swept" | The route is congested. Try again, or scope the search to a section. No further calls are made after this point. |
| "Jev rejected the key — check it in Tracky's options." | The route answered 401/403: the key is wrong, expired, or not for that route. Test key tells you in one call. |
| "Direct mode has no key yet — open Tracky's options and paste your Jev key." | Exactly that; direct mode cannot search without one. |
| "Jev's free route is rate-limited — about N minutes to go" | Wait it out or point `JEV_BASE_URL` at a paid route in `server/.env`. |
| "no readable text found on this page" | The page is a stub, an app shell, or has almost no prose. Try a section scope or another page. |
| "can't read this page" tooltip on the icon | Browser pages, PDFs and `file://` are off-limits (see limits). |
| Nothing happens on Ctrl+F | Open the panel once with Alt+K on that tab first, or check the hijack option. |
| A sentence "no longer on this page" | The page changed under you — press the ⟳ rescan button. |

## Repo map

| Folder | What | Owner |
| --- | --- | --- |
| `extension/` | MV3 Chrome extension (panel, collector, options) | Ammar |
| `server/` | Local helper (Node) — the only place the key lives | Ammar |
| `app/` | React playground (+ mocks) | Hamdan |
| `docs/` | API contract, judge ledger, verification logs | both |
| `scripts/` | Smoke harness, judge, packaging, audits | Ammar |
| `spikes/` | Fixtures and experiments | Ammar |

## Development commands

```bash
node --test server/test/*.test.mjs extension/direct.test.mjs   # 161 unit tests
node server/server.mjs                    # start the helper (127.0.0.1:4199)
node scripts/package-extension.mjs        # deterministic allowlist zip → dist/
node scripts/key-leak-check.mjs           # prove the key is only in server/.env
node scripts/benchmark.mjs                # fixed suite through the real model
node scripts/hostile-text.mjs             # injection bait must not win
xvfb-run -a python3 scripts/ext-smoke.py  # 46 real-browser checks (fixture)
TRACKY_SMOKE_URL="https://en.wikipedia.org/wiki/Lease" TRACKY_SMOKE_QUERY="security deposit" \
  xvfb-run -a python3 scripts/ext-smoke.py   # the same checks on a real site
xvfb-run -a python3 scripts/direct-smoke.py  # direct mode, live, helper stopped mid-run
xvfb-run -a python3 scripts/react-survival.py  # React pages survive untouched
./scripts/verify-all.sh                   # everything, one command (--no-model skips the model steps)
```

## Key documents

- `docs/contract.md` — the frozen v1 API contract
- `docs/judge-report.md` — every artifact's independent judge verdict, with fixes applied
- `PLAN.md` — the phased build plan and what is ticked

## Credits

Inspired by the excellent open-source [Needle](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_llm_apps/needle) (Apache-2.0) — this is our own from-scratch build with a different feature set. Model: [TypeSafe Jev](https://docs.typesafe.ai).

## License

MIT — see [LICENSE](LICENSE).
