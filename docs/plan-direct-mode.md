# Direct mode — build plan (approved 27 Sep 2026)

**Goal:** the extension can talk to Jev itself, with a key the *user* pastes — no helper,
no Node, no terminal. For the Web Store, that is the whole onboarding: install → paste
key → works. The helper stays the default mode; direct mode is a switch.

## Decisions (locked with ʿAmmār)

- Mode default for fresh installs: **Local helper** (unchanged story).
- Key storage: **chrome.storage.local only** (never synced, never sent anywhere except
  the chosen Jev route).
- Ships as **0.7.0** in the same repo. Web Store listing update is a later, separate task.
- The user's key is never involved in anyone else's install — each user brings their own.

## UX (options page)

New section "Connect" with:

1. Mode switch: **Local helper** (default) / **Direct**.
2. Direct mode: key field (`type=password`), the same "Where Jev comes from" dropdown
   (paid `jev-1.13` / free `jev-1.13-free`), and a **Test key** button that makes one
   tiny call and shows ✓ / ✗ with the provider's own message on failure.
3. In direct mode the helper-status line reads "direct — no helper needed".
4. Copy states plainly: the key is stored in this browser's storage on this machine.

## Files and exact changes

| File | Change |
| --- | --- |
| `extension/direct.js` (new) | Jev client (same request shape as `server/jev.mjs`) + **port of the zero-hallucination validator** (`server/validate.mjs`, `server/search.mjs` picking, `server/why.mjs` why-shape) + the batching/chunk constants (`BATCH_MAX`, `LIMITS`) |
| `extension/background.js` | `runSearch`/`runWhy` branch on mode: direct → `direct.js`; response shape identical so `content.js` is untouched |
| `extension/options.html` / `options.js` | the Connect section; persist `mode` + `directKey` + `directSource` in `chrome.storage.local` |
| `extension/manifest.json` | `optional_host_permissions: ["https://opencode.ai/*"]`, requested only when Direct is enabled; default install stays permission-free |
| `extension/direct.test.mjs` (new) | validator specs mirroring the server's cases: picks must be existing sentence indexes, wrong/extra/missing picks throw, sentence text comes from OUR splitter, hostile text safe |
| `scripts/direct-smoke.py` (new) | live: enable Direct, paste key (read locally from `server/.env`, never printed), real search on a real page, assert highlights + that the key never appears in page/console/storage-export |
| `README.md`, `docs/contract.md` | second setup path + the direct contract |

## Hard rules

- Zero hallucination holds in BOTH modes: the model picks sentence **indexes**; the
  sentence text is rendered from our own splitter. The validator port is the load-bearing
  piece — port it first, test it first.
- The key is never logged, never echoed, never committed; `scripts/key-leak-check.mjs`
  must also scan the extension for key-shaped strings (it already does via packaging).
- A 429 from the route = BLOCKED in every suite, never FAIL (existing rule).

## Verification checklist (his standard — all must pass live)

1. `node --test server/test/*.test.mjs extension/direct.test.mjs` — all green.
2. `scripts/direct-smoke.py` live: real page, direct mode, real search, highlights land.
3. Helper mode still fully green: `ext-smoke.py` 50/50, `source-picker-smoke.py` 11/11.
4. Full battery `./scripts/verify-all.sh` — 12/12 (heavy steps included).
5. Judge pass on the feature; fix loop until >8.5 or report the plateau honestly.
6. Commit + push; version 0.7.0 zip built and verified.

## Jev cost estimate

~10–15 searches total for the whole feature (validator tests are offline).

## What changed after the plan (and why)

- `content.js` **did** need one branch after all: the plan said the response shape is
  identical, and it is — but the health line has to say *which* mode answered. Direct
  mode synthesizes a local health reply (`{name:"tracky-direct", direct:true, ready}`)
  and the ping now renders `direct · <model> · ready`, or names the missing piece
  (no key / no origin permission). A stale "helper … ready" line after a reload would be
  a lie about the running mode; the options page now pings *after* the saved mode is read,
  and the smoke checks it.
- `searchText` gained a whole-search budget (`DEFAULT_BUDGET_MS = 40s`, under the panel's
  45s wait). Without it a 1200-passage sweep could fire 15 chunks × 20s serially and the
  panel would give up first, leaving calls running against the route. The first chunk
  always runs; later chunks only while the budget holds.
- A 429 now keeps status **429** (was folded into 502 with the same message): the hard
  rule — a quota window is BLOCKED, never a product failure — is enforced by the status,
  not only by the wording.
- The sentence segmenter is built on first use instead of at load: `direct.js` is
  `importScripts`-ed by the worker, so a load-time throw on a browser without
  `Intl.Segmenter` would take down the whole extension in both modes.
- The `noul ?? probability` score fallback stays: `server/validate.mjs` accepts either
  field name, and direct mode must not be stricter than helper mode. Missing/non-numeric
  values still fail loudly.
