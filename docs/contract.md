# Tracky API contract — v1 (frozen 2026-09-26)

The helper exposes **one endpoint**. The extension and the playground both talk to it.
Until this file changes, this shape is law — clients can build against `app/mock/` before the server exists.

## Endpoint

```
POST http://127.0.0.1:4199/api/search
Content-Type: application/json
Body <= 512 KB
```

## Request

```json
{
  "query": "hidden charges",
  "passages": [
    { "id": "p0", "text": "First readable block of the page..." },
    { "id": "p1", "text": "Second block..." }
  ],
  "provider": "zen-free"
}
```

Rules:

- `query`: 1–1,000 chars.
- `passages`: 1–600 items; each `text` <= 2,200 chars; combined <= ~400k chars.
  Long pages are sent **whole** — the server chunks internally (the "full-page sweep"). Clients do NOT chunk.
- `id`: stable for the session; used to map results back to the page.
- `provider` (optional): which configured Jev source to use, from `GET /api/providers`.
  Omitted → the helper's default. An unknown id is a **400** naming the ones that exist;
  a source without its own key is a **503** naming the exact `.env` line to add.

## GET /api/providers

The extension's source dropdown is built from this — labels and models only, never a key.

```json
{
  "default": "zen-paid",
  "providers": [
    { "id": "zen-paid", "label": "OpenCode Zen · Jev 1.13 (paid)", "kind": "paid", "model": "jev-1.13", "configured": true },
    { "id": "zen-free", "label": "OpenCode Zen · Jev 1.13 (free window)", "kind": "free", "model": "jev-1.13-free", "configured": true },
    { "id": "typesafe", "label": "TypeSafe AI (direct)", "kind": "paid", "model": "jev-latest", "configured": false }
  ]
}
```

## Response 200

```json
{
  "results": [
    { "passageId": "p0", "sentence": "A service charge of Rs.250 applies.", "score": 0.87 },
    { "passageId": "p4", "sentence": "Cancellations within 24h are free.", "score": 0.61 }
  ]
}
```

Guarantees:

- `sentence` is ALWAYS an exact substring of the passage it points to — never generated, never paraphrased.
  If an answer cannot be validated (score not 0–1, sentence not found), the server errors — it never
  fabricates and never returns partial results.
- `score` is in [0, 1] — relevance confidence. Results are sorted best-first.
- `results` may be `[]` (nothing relevant found — a valid answer).
- Additive compatibility: new fields may be added later; existing fields and meanings never change without a v2.

## Errors

- `400 { "message": "..." }` — bad request (malformed JSON, empty query, caps exceeded).
- `413 { "message": "..." }` — body too large.
- `502 { "message": "..." }` — upstream (Jev) failure or an unvalidatable answer. Retry-safe.

Clients should show `message` for 4xx/5xx, and a "helper not running" state on network failure (fetch throws).

## POST /api/why — why-chips (v1, added Phase 7)

Request: `{ "query": "…", "matches": [{ "passageId": "p0", "sentence": "…" }], "redact": true? }`

- `matches`: 1–8 entries; `passageId` uses the same `p0, p1, …` ids as search; sentences are page text.
- `redact: true` applies the same same-length masking as search before anything leaves the helper.

Response: `{ "reasons": [{ "passageId": "p0", "reason": "states a price or fee" | null }], "stats": { "ms": 790, "usage": { … } } }`

- The reason is ALWAYS one of the helper's fixed labels (a closed list the client also knows):
  `states a price or fee · states a rule or requirement · states a deadline or time limit · defines a term ·
   gives an example · explains a process or steps · lists an exception · warns about a risk or penalty`
- The model only PICKS a label — it never writes prose. A malformed pick returns `null` for that match
  (chip dropped, never guessed).
- Errors match the shapes above (400/413/502).

## Not part of this contract (client-side)

- Literal ("exact word") matches — computed client-side from the same passages.
- Answer card composition — the client renders top results; the server stays a pure finder.
- Highlighting/painting — client-side (extension paints the page; playground paints its preview).
- Why-chip *display*: the client decides which matches get chips and how they read.

## Direct mode — the same contract, run inside the extension (added 0.7.0)

The extension can also reach Jev by itself, with a key the user pastes in the options
page — no helper, no Node, no terminal. **Nothing about the wire shapes above changes**:
the same request body is built, the same no-fabrication gate adjudicates the answer, and
the panel receives the same `{ results }` / `{ reasons }` payloads it gets from the
helper. What moves is *where* the engine runs: `extension/direct.js` is a port of the
helper's brain (splitter, request builder, validator, ranker, chip pass) with the same
constants, and `extension/direct.test.mjs` mirrors the server's own cases against it.

- Identical caps: batch **80**, ≤**1,200** passages, ≤**400,000** characters, query ≤**400** chars.
- `sentence` is still an exact character slice of the passage; an unknown passage id, an
  out-of-range pick or a nonsense score still fails loudly (the same 502 semantics), and
  the answer is never repaired.
- The pick is an **index** only: model-authored prose (`text`, `offsets`) is ignored, and
  the sentence text comes from our splitter.
- No `provider` field: the route is the one the user picked in the options page
  (`zen-paid` → `jev-1.13`, `zen-free` → `jev-1.13-free`), sent with the user's own key in
  the `Authorization: Bearer …` header.
- **Not ported, on purpose:** SSE progress, the abort plumbing, `redact` (in direct mode
  there is no helper hop whose config could switch redaction on — the text goes from the
  user's machine straight to the route they chose).
- The key lives in `chrome.storage.local` on that machine only: never synced, never sent
  anywhere except the chosen route, never written into a package. Direct mode adds **no
  install-time permission** — the host permission for the route is requested at the
  moment the user picks Direct, and a search without it fails with the reason, not a
  mystery.

## Mocks (build the client before the server exists)

- `app/mock/search.json` — happy path (3 results)
- `app/mock/search-empty.json` — zero results (valid answer)
- `app/mock/search-error.json` — 502 error body
