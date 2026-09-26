#!/usr/bin/env python3
"""Tracky — the real-page suite (Phase 11.5): 10 real pages × 3 queries.

Two modes so the browser work and the model work can happen separately:

  python3 scripts/realpage-suite.py --collect   collect passages from the 10 pages
                                                (browser only, no model, no key needed)
  python3 scripts/realpage-suite.py --run       ask 3 real questions per page through
                                                the real helper and write docs/verification.md

Every run asserts the invariant the whole project rests on: each returned sentence
must be an exact substring of the passage it claims to come from. Relevance is
logged for a human to read — it is not something this script can honestly grade.

The free model route rate-limits, so --run accepts --only=name1,name2 to verify the
pages in chunks across windows instead of losing the whole suite to one 429.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "spikes" / "out" / "realpages"
HELPER = "http://127.0.0.1:4199"

# Ten real pages, chosen for variety: encyclopedic prose, a licence, docs, a short
# about page, and one deliberately thin page so the honest-empty path is exercised.
PAGES = [
    ("lease", "https://en.wikipedia.org/wiki/Lease",
     ["what does the tenant pay upfront", "who is responsible for repairs", "how long can a lease run"]),
    ("security-deposit", "https://en.wikipedia.org/wiki/Security_deposit",
     ["when is the deposit returned", "what can the landlord deduct", "is interest paid on it"]),
    ("eviction", "https://en.wikipedia.org/wiki/Eviction",
     ["how much notice is required", "what happens after a court order", "who can be evicted"]),
    ("insurance", "https://en.wikipedia.org/wiki/Insurance",
     ["what does a deductible mean", "how do premiums work", "what is excluded"]),
    ("gpl", "https://www.gnu.org/licenses/gpl-3.0.en.html",
     ["can i sell software that uses this", "must i share my changes", "what about patents"]),
    ("udhr", "https://en.wikisource.org/wiki/Universal_Declaration_of_Human_Rights",
     ["what rights does everyone have", "who may leave a country", "what about education"]),
    ("constitution", "https://en.wikisource.org/wiki/Constitution_of_the_United_States_of_America",
     ["who can declare war", "how are judges appointed", "what is the bill of rights"]),
    ("mdn-highlight", "https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API",
     ["how do i style a highlight", "which browsers support it", "can i highlight text ranges"]),
    ("node-about", "https://nodejs.org/en/about",
     ["what is node used for", "who maintains it", "is it open source"]),
    ("thin-page", "https://en.wikipedia.org/wiki/Rental_agreement",
     ["what must be included in writing", "how can it be ended", "who signs it"]),
]


def collect() -> int:
    from playwright.sync_api import sync_playwright

    collect_js = (ROOT / "extension" / "collect.js").read_text()
    OUT.mkdir(parents=True, exist_ok=True)

    def find_chrome() -> str:
        for pattern in ("chromium-*/chrome-linux64/chrome", "chromium-*/chrome-linux/chrome"):
            for cand in sorted(Path.home().glob(f".cache/ms-playwright/{pattern}")):
                if cand.exists():
                    return str(cand)
        for name in ("google-chrome", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                return found
        raise SystemExit("no Chrome found")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=find_chrome(), args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()
        for name, url, _ in PAGES:
            target = OUT / f"{name}.json"
            if target.exists():
                print(f"  · {name}: already collected")
                continue
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(1200)
                page.evaluate(collect_js)
                got = page.evaluate("() => window.__trackyCollect()")
                blocks = got.get("blocks") or []
                target.write_text(json.dumps({"url": url, "blocks": blocks, "stats": got.get("stats")}, indent=1))
                print(f"  ✓ {name}: {len(blocks)} passages ({got.get('stats', {}).get('chars', 0)} chars)")
            except Exception as e:  # noqa: BLE001 — a failed page must not stop the suite
                print(f"  ✗ {name}: {type(e).__name__}: {str(e)[:90]}")
        browser.close()
    return 0


def run() -> int:
    import urllib.request

    def post(payload: dict, timeout: int = 60) -> dict:
        req = urllib.request.Request(
            f"{HELPER}/api/search",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())

    rows = []
    problems = []
    only = ""
    for arg in sys.argv:
        if arg.startswith("--only="):
            only = arg.split("=", 1)[1]
    wanted = {n.strip() for n in only.split(",") if n.strip()} if only else None
    for name, url, queries in PAGES:
        if wanted and name not in wanted:
            continue
        src = OUT / f"{name}.json"
        if not src.exists():
            rows.append((name, url, 0, "—", "not collected", 0, "—"))
            continue
        data = json.loads(src.read_text())
        blocks = data["blocks"]
        for q in queries:
            if not blocks:
                rows.append((name, url, 0, q, "no readable text", 0, "—"))
                continue
            t0 = time.time()
            try:
                body = post({"query": q, "passages": blocks})
            except Exception as e:  # noqa: BLE001
                rows.append((name, url, len(blocks), q, f"error: {str(e)[:60]}", 0, "—"))
                problems.append(f"{name} / “{q}” → {e}")
                continue
            ms = int((time.time() - t0) * 1000)
            results = body.get("results", [])
            # The invariant: every sentence is an exact slice of its passage.
            by_id = {b["id"]: b["text"] for b in blocks}
            for r in results:
                src_text = by_id.get(r["passageId"], "")
                if r["sentence"] not in src_text:
                    problems.append(f"{name} / “{q}” → sentence not an exact slice of {r['passageId']}")
                if not (0 < r["score"] <= 1):
                    problems.append(f"{name} / “{q}” → score {r['score']} out of range")
            top = results[0] if results else None
            rows.append(
                (name, url, len(blocks), q, f"{len(results)} match(es)", ms,
                 f"{top['score']} · {top['sentence'][:110]}" if top else "— (honest empty)")
            )
            print(f"  {name}: “{q}” → {len(results)} match(es) in {ms} ms")

    md = ["# Tracky — real-page verification (Phase 11.5)", ""]
    md.append(f"Generated {time.strftime('%d %b %Y %H:%M IST')} · model via the local helper · 10 real pages × 3 questions.")
    md.append("")
    md.append("The invariant checked on every row: **each returned sentence is an exact substring of the passage it came from**, and every score is inside 0–1. Relevance is shown so a human can judge it — a script cannot honestly grade meaning.")
    md.append("")
    md.append("| page | passages | question | result | ms | top sentence (score) |")
    md.append("| --- | --- | --- | --- | --- | --- |")
    for name, url, n, q, res, ms, top in rows:
        md.append(f"| [{name}]({url}) | {n} | {q} | {res} | {ms or '—'} | {top.replace('|', '/')} |")
    md.append("")
    md.append(f"**Invariant violations: {len(problems)}**")
    for p in problems:
        md.append(f"- {p}")
    md.append("")
    (ROOT / "docs" / "verification.md").write_text("\n".join(md))
    print(f"\nwrote docs/verification.md — {len(rows)} rows, {len(problems)} invariant violation(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    if "--collect" in sys.argv:
        sys.exit(collect())
    if "--run" in sys.argv:
        sys.exit(run())
    print(__doc__)
    sys.exit(2)
