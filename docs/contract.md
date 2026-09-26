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
  ]
}
```

Rules:

- `query`: 1–1,000 chars.
- `passages`: 1–600 items; each `text` <= 2,200 chars; combined <= ~400k chars.
  Long pages are sent **whole** — the server chunks internally (the "full-page sweep"). Clients do NOT chunk.
- `id`: stable for the session; used to map results back to the page.

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

## Not part of this contract (client-side)

- Literal ("exact word") matches — computed client-side from the same passages.
- Answer card composition — the client renders top results; the server stays a pure finder.
- Highlighting/painting — client-side (extension paints the page; playground paints its preview).

## Mocks (build the client before the server exists)

- `app/mock/search.json` — happy path (3 results)
- `app/mock/search-empty.json` — zero results (valid answer)
- `app/mock/search-error.json` — 502 error body
