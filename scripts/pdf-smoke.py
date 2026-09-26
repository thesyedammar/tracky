#!/usr/bin/env python3
"""Prove PDF mode (Phase 13) works in a real Chromium.

What is verified, with no model needed:
  1. the extension page opens a real 15-page PDF and renders every page,
  2. pdf.js builds a text layer (thousands of spans),
  3. our collector turns that text layer into blocks with exact offsets,
  4. every block's text is really the concatenation of its own spans (the
     never-fabricate guarantee, checked directly against the DOM),
  5. the panel is present and usable on the PDF (same content script),
  6. a sentence range built from our segment map paints a real highlight on the
     PDF text layer (the CSS Custom Highlight API path, checked live),
  7. page sections are the PDF's pages,
  8. zero page JS errors while all of that happened.

The search itself needs the model, so it is not asserted here — scripts/ext-smoke.py
covers the live search path on normal pages, and the same panel code is reused here.

Run:  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/pdf-smoke.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
OUT = ROOT / "spikes" / "out"

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


def find_chrome() -> str:
    env = os.environ.get("TRACKY_CHROME")
    if env and Path(env).exists():
        return env
    for pattern in ("chromium-*/chrome-linux64/chrome", "chromium-*/chrome-linux/chrome"):
        for cand in sorted(Path.home().glob(f".cache/ms-playwright/{pattern}")):
            if cand.exists():
                return str(cand)
    for name in ("google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit("no Chrome found — set TRACKY_CHROME=/path/to/chrome")


def main() -> int:
    pdf = EXT / "tests" / "sample.pdf"
    if not pdf.exists():
        print(f"missing fixture {pdf}")
        return 2

    with tempfile.TemporaryDirectory(prefix="tracky-pdf-profile-") as profile, sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=profile,
            executable_path=find_chrome(),
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1280,900",
                "--window-position=0,0",
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
            ],
        )
        try:
            worker = None
            for _ in range(150):
                if ctx.service_workers:
                    worker = ctx.service_workers[0]
                    break
                time.sleep(0.1)
            check("extension service worker is alive", worker is not None)
            if worker is None:
                return 1
            ext_id = worker.url.split("/")[2]
            check("extension id resolved", bool(ext_id), ext_id)

            errors: list[str] = []
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on(
                "console",
                lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
            )

            src = f"chrome-extension://{ext_id}/tests/sample.pdf"
            t_open = time.time()
            page.goto(
                f"chrome-extension://{ext_id}/pdf.html?src={src}&name=sample.pdf",
                wait_until="domcontentloaded",
                timeout=60000,
            )

            ready = False
            for _ in range(240):  # 15 pages + text layers can take a while cold
                ready = page.evaluate("() => window.__trackyPdfReady === true")
                if ready:
                    break
                time.sleep(0.25)
            render_ms = int((time.time() - t_open) * 1000)
            check("PDF rendered and collector is live", ready, f"open→ready in {render_ms} ms")
            if not ready:
                detail = page.evaluate("() => (document.getElementById('load-msg') || {}).textContent || ''")
                check("(renderer state)", False, str(detail)[:160])
                page.screenshot(path=str(OUT / "tracky-pdf.png"))
                return 1

            stats = page.evaluate("() => window.__trackyPdfStats")
            check("every page rendered", stats.get("pages") == 15, f"{stats.get('pages')} pages")
            wrappers = page.evaluate("() => document.querySelectorAll('.page').length")
            check("a page element per page", wrappers == stats.get("pages"), f"{wrappers} page elements")
            # Canvases are lazy on purpose (a 15-page paper at 2x DPR is ~240 MB of
            # pixels). The first pages must be painted; a later one must paint when
            # the reader actually reaches it.
            painted = page.evaluate("() => document.querySelectorAll('.page canvas:not([data-pending])').length")
            check("the pages you can see are painted", painted >= 2, f"{painted} canvases painted up front")
            page.evaluate("() => document.querySelector('.page[data-page=\"10\"]').scrollIntoView({ block: 'center' })")
            time.sleep(1.2)
            late = page.evaluate("() => !!document.querySelector('.page[data-page=\"10\"] canvas:not([data-pending])')")
            check("a later page paints when reached (lazy canvas)", late, "page 10 painted on approach")
            spans = page.evaluate("() => document.querySelectorAll('.textLayer span').length")
            check("pdf.js built a real text layer", spans > 1000, f"{spans} spans")

            got = page.evaluate("() => { const r = window.__trackyCollect(); return { blocks: r.blocks.length, chars: r.stats.chars, sections: r.sections.map(s => s.name), ids: r.blocks.slice(0, 3).map(b => b.id) }; }")
            check("collector produced blocks", got["blocks"] >= 20, f"{got['blocks']} blocks / {got['chars']} chars")
            # A page that is all figures or all references can honestly contribute
            # nothing, so this asserts "most pages", and names the ones that did not.
            pages_with_text = {s.replace("Page ", "") for s in got["sections"]}
            missing = sorted({str(n) for n in range(1, stats.get("pages", 0) + 1)} - pages_with_text, key=int)
            check(
                "sections are the PDF's pages",
                len(pages_with_text) >= 13,
                f"{len(pages_with_text)}/{stats.get('pages')} pages carry passages"
                + (f" (no readable text on page {', '.join(missing)})" if missing else ""),
            )
            check("block ids follow the contract", got["ids"] == ["p0", "p1", "p2"], str(got["ids"]))

            # The never-fabricate check, verified against the DOM itself: every
            # character of a block must come from that block's own spans.
            faithful = page.evaluate(
                """() => {
                    const r = window.__trackyCollect();
                    let bad = 0, checked = 0;
                    for (const [id, entry] of r.byId) {
                        let rebuilt = '';
                        const parts = [];
                        for (const s of entry.segments) {
                            if (!s.node || !s.node.parentElement) continue;
                            parts.push([s.start, s.node.data.slice(s.base, s.base + (s.end - s.start))]);
                        }
                        parts.sort((a, b) => a[0] - b[0]);
                        for (const [start, piece] of parts) {
                            while (rebuilt.length < start) rebuilt += ' ';
                            rebuilt = rebuilt.slice(0, start) + piece + rebuilt.slice(start + piece.length);
                        }
                        checked++;
                        if (rebuilt.replace(/ +/g, ' ').trim() !== entry.text.replace(/ +/g, ' ').trim()) bad++;
                    }
                    return { checked, bad };
                }"""
            )
            check(
                "every block is exactly its own spans (no invented text)",
                faithful["bad"] == 0,
                f"{faithful['checked']} blocks checked, {faithful['bad']} mismatched",
            )

            panel = page.evaluate(
                """() => { const h = document.getElementById('tracky-root');
                    return !!(h && h.shadowRoot && h.shadowRoot.querySelector('.wrap')); }"""
            )
            check("the same panel is live on the PDF", panel)

            # The panel floats; the document must slide out from under it (and slide
            # back when the panel closes), or the two overlap on a real screen.
            shifted = page.evaluate(
                """() => { const el = document.getElementById('pages');
                    return { open: document.body.classList.contains('panel-open'),
                             pad: parseFloat(getComputedStyle(el).paddingRight) }; }"""
            )
            check("the document slides out from under the open panel", shifted["open"] and shifted["pad"] > 300, f"padding-right {shifted['pad']}px")
            closed = page.evaluate(
                """() => { const h = document.getElementById('tracky-root');
                    const b = h && h.shadowRoot && h.shadowRoot.querySelector('.close');
                    if (!b) return null; b.click(); return true; }"""
            )
            time.sleep(0.5)
            after = page.evaluate("() => document.body.classList.contains('panel-open')")
            check("and slides back when it closes", closed is True and after is False, f"closed={closed} still-open={after}")
            page.evaluate(
                """() => { const h = document.getElementById('tracky-root');
                    const b = h && h.shadowRoot && h.shadowRoot.querySelector('.dot');
                    if (b) b.click(); }"""
            )
            time.sleep(0.4)

            # Highlight path: take a real sentence out of a block, build the range
            # through our segment map, and paint it with the Custom Highlight API.
            hl = page.evaluate(
                """() => {
                    const r = window.__trackyCollect();
                    const entry = [...r.byId.entries()].find(([, e]) => e.text.length > 200);
                    if (!entry) return { ok: false, why: 'no long block' };
                    const [id, e] = entry;
                    const sentenceStart = Math.max(0, e.text.indexOf('.') + 2);
                    const sentenceEnd = e.text.indexOf('.', sentenceStart) + 1 || sentenceStart + 60;
                    const mk = (pos) => {
                        for (const s of e.segments) {
                            if (pos >= s.start && pos <= s.end) return { node: s.node, off: s.base + (pos - s.start) };
                        }
                        return null;
                    };
                    const a = mk(sentenceStart), b = mk(sentenceEnd);
                    if (!a || !b) return { ok: false, why: 'no segment for range' };
                    const range = new Range();
                    range.setStart(a.node, Math.min(a.off, a.node.data.length));
                    range.setEnd(b.node, Math.min(b.off, b.node.data.length));
                    const text = range.toString();
                    CSS.highlights.set('tracky-hl', new Highlight(range));
                    return { ok: true, id, text: text.slice(0, 70), painted: CSS.highlights.has('tracky-hl') };
                }"""
            )
            check("a sentence range paints on the PDF text layer", bool(hl.get("ok")) and hl.get("painted"), str(hl.get("text", hl.get("why"))))
            check("the painted range carries real sentence text", len(str(hl.get("text", ""))) > 20, str(hl.get("text", ""))[:70])

            page.evaluate("() => { const el = document.querySelector('.page'); el && el.scrollIntoView({ block: 'start' }); }")
            time.sleep(0.4)
            OUT.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(OUT / "tracky-pdf.png"))
            check("no page JS errors", not errors, "; ".join(errors[:3])[:200])
        finally:
            ctx.close()

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    print(f"\n{passed}/{len(CHECKS)} checks passed — {'ALL GOOD' if passed == len(CHECKS) else 'FAILURES PRESENT'}")
    if passed != len(CHECKS):
        print(json.dumps([c for c in CHECKS if not c[1]], indent=1))
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
