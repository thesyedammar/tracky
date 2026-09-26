# Tracky — Ctrl+F that finds by meaning

> Type *"hidden charges"* on a page that never uses those words and Tracky highlights the sentence you actually meant — **with receipts**: the exact text, in its exact place, nothing invented.

**Status: Phases 0–9 built and verified.** The engine, the local helper and the extension are live and measured (numbers below). PDF mode, the playground and the packaging polish are next — see `PLAN.md`.

## The 60-second tour

1. Start the helper: `node server/server.mjs` (it holds your key in `server/.env`).
2. Load the extension: `chrome://extensions` → *Developer mode* → *Load unpacked* → pick `extension/`.
3. Open any long page, press **Alt+K** (or **Ctrl+F**), type what you mean, press Enter.
4. The best sentence is quoted in the panel; click it and it scrolls to and glows on the page itself.

## Why it is different

| | Browser Ctrl+F | "AI search" chatbots | Tracky |
| --- | --- | --- | --- |
| Finds by meaning | ✗ (letters only) | ✓ | ✓ |
| Shows where it is on the page | ✗ | ✗ | ✓ (highlights the exact sentence in place) |
| Can invent text | ✗ | often | **never** — every quote is an exact slice of the page |
| Where your page text goes | nowhere | a vendor's servers | **your own local helper** (then the model route you configured) |

The trick that makes "never" real: the model is only allowed to **pick** from sentences that already exist on the page. Every pick is re-verified as an exact character slice before it is shown; anything that fails to verify fails the search loudly instead of guessing.

## Real numbers (measured, not estimated)

| What | Result |
| --- | --- |
| Local fixture (10 passages) | 6 matches · **723–736 ms** |
| `en.wikipedia.org/wiki/Lease` (106–107 passages) | 5 matches · **1.05–1.5 s** |
| Repeat question (cached) | instant, zero model calls |
| Scoped search (one section of a page) | 107 → 6 passages searched |
| Unit tests | **100/100** (`node --test server/test/*.test.mjs`) |
| Extension smoke checks | **46/46** on the fixture **and** on Wikipedia |
| React survival (real React 18 app) | **9/9** — 0 nodes added/removed inside the app's root |
| Key-leak audit | tree + zip + all 10 commits → **0 leaks** |
| Independent judge (Muse Spark 1.3) | every phase accepted at **8.6–9.1 / 10** (`docs/judge-report.md`) |

## What leaves your machine

- Page text goes **page → your local helper (127.0.0.1) → the model route in `server/.env`**. Nothing else sees it. The helper binds to loopback only.
- The helper logs **counts, never text** (passages in, matches out, milliseconds).
- The API key lives **only** in `server/.env` (chmod 600, gitignored). It is never sent to the extension, never logged, never committed — `scripts/key-leak-check.mjs` proves it across the working tree, the packaged zip and every commit.
- **Redact mode** masks phone numbers, emails, cards, PANs and similar PII with same-length `•` *before* the text leaves, so offsets and highlights still line up.
- **Per-site deny list** in the options page — listed sites never even get the panel injected.
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

## Limits (the honest list)

- **The helper must be running.** Without it the panel says exactly that, with the command to fix it.
- **The free model route rate-limits.** When it does, Tracky reports the real wait ("about 100 minutes to go") instead of pretending to search.
- **PDFs and `file://` pages are not supported yet** (PDF mode is Phase 13). Browser-internal pages can never be scripted.
- **Ctrl+F hijack needs one prior Alt+K on that tab.** The extension deliberately holds no `host_permissions`, so its panel can only exist where you opened it.
- **Very long pages cost more time** — one model request per 80 passages, run in sequence (a 1,000-passage page is ~13 passes).
- **Scores are model opinions**, which is why they are shown as percentages and gated rather than trusted.
- The cache is per-tab and short-lived (10 minutes, 24 entries).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "helper not running — start it: node server/server.mjs" | Start the helper in a terminal; the panel re-checks on every open. |
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
node --test server/test/*.test.mjs        # 100 unit tests
node server/server.mjs                    # start the helper (127.0.0.1:4199)
node scripts/package-extension.mjs        # deterministic allowlist zip → dist/
node scripts/key-leak-check.mjs           # prove the key is only in server/.env
node scripts/benchmark.mjs                # fixed suite through the real model
node scripts/hostile-text.mjs             # injection bait must not win
xvfb-run -a python3 scripts/ext-smoke.py  # 46 real-browser checks (fixture)
TRACKY_SMOKE_URL="https://en.wikipedia.org/wiki/Lease" TRACKY_SMOKE_QUERY="security deposit" \
  xvfb-run -a python3 scripts/ext-smoke.py   # the same checks on a real site
xvfb-run -a python3 scripts/react-survival.py  # React pages survive untouched
```

## Key documents

- `docs/contract.md` — the frozen v1 API contract
- `docs/judge-report.md` — every artifact's independent judge verdict, with fixes applied
- `PLAN.md` — the phased build plan and what is ticked

## Credits

Inspired by the excellent open-source [Needle](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_llm_apps/needle) (Apache-2.0) — this is our own from-scratch build with a different feature set. Model: [TypeSafe Jev](https://docs.typesafe.ai).

## License

MIT — see [LICENSE](LICENSE).
