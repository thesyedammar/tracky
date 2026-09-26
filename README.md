# Tracky — Ctrl+F that finds by meaning

> Search any page by **meaning**, not exact words: describe what you are looking for ("hidden charges") and Tracky highlights the sentence you meant — with **receipts**: the exact text, in its exact place, nothing invented.

**Status: Phases 0–1 done.** Contract frozen, mocks live; the Jev brain is proven with real numbers (spikes ran on the free route). Building the engine next (Phase 2).

## What it will be

- **Chrome extension** — press Ctrl+F on any page, describe what you mean, the winning sentence glows in place.
- **Local helper** — a tiny Node server (127.0.0.1:4199) that holds the API key and talks to [Jev (TypeSafe System One)](https://docs.typesafe.ai). The key never enters the browser.
- **Playground** — paste any article or policy and search it the same way, no install needed.

## Why "with receipts"?

Most "AI search" invents answers. Tracky only **picks existing sentences** and validates every answer before showing it — if it cannot verify, it errors instead of guessing. Planned upgrades over the classic approach: full-page sweep, hybrid literal + meaning matches, an answer card with clickable receipts, payload preview and redact mode.

## Repo map

| Folder | What | Owner |
| --- | --- | --- |
| `extension/` | MV3 Chrome extension | Ammar |
| `server/` | Local helper (Node) — the only place the key lives | Ammar |
| `app/` | React playground (+ mocks) | Hamdan |
| `docs/` | API contract, verification logs | both |
| `spikes/` | Throwaway experiments | Ammar |

## Key documents

- `docs/contract.md` — frozen v1 API contract (extension and playground both build against it)
- `PLAN.md` — full phased build plan with checkboxes
- `app/mock/` — mock responses so the playground can be built before the helper exists

## Credits

Inspired by the excellent open-source [Needle](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_llm_apps/needle) (Apache-2.0) — this is our own from-scratch build with a different feature set. Model: [TypeSafe Jev](https://docs.typesafe.ai).

## License

MIT — see [LICENSE](LICENSE).
