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

            got = page.evaluate("() => { const r = window.__trackyCollect(); return { blocks: r.blocks.length, chars: r.stats.chars, sections: r.sections.map(s => s.name), ids: r.blocks.slice(0, 3).map(b => b.id), hash: r.stats.hash, ms: r.stats.ms, skipped: r.stats.skipped, detail: r.stats.skippedDetail, spans: r.stats.spans, byIdSize: r.byId.size, sectionSum: r.sections.reduce((a, s) => a + s.count, 0), title: (r.blocks.find(b => b.text.includes('Attention Is All You Need')) || {}).text || '', longest: Math.max(...r.blocks.map(b => b.text.length), 0) }; }")
            check("collector produced blocks", got["blocks"] >= 20, f"{got['blocks']} blocks / {got['chars']} chars")
            # Real stats, not placeholders: the fingerprint is a real FNV-1a value, the
            # timing is measured, and the skip counters add up.
            check("stats carry a real fingerprint and timing", isinstance(got["hash"], int) and got["hash"] > 0 and got["ms"] >= 0, f"hash={got['hash']} ms={got['ms']}")
            detail = got["detail"] or {}
            skips = (
                detail.get("short", 0)
                + detail.get("dedupe", 0)
                + detail.get("capped", 0)
                + detail.get("cappedPages", 0)
                + detail.get("pageErrors", 0)
            )
            check(
                "skip counters are real",
                got["skipped"] == skips and detail.get("considered", 0) == got["spans"],
                f"skipped {got['skipped']} == {skips} · considered {detail.get('considered')} == spans {got['spans']}",
            )
            # Every block must be addressable and every address must be a block: a
            # registry entry for a dropped block would highlight nothing.
            check(
                "byId and blocks agree (no orphan entries)",
                got["byIdSize"] == got["blocks"] and got["sectionSum"] == got["blocks"],
                f"byId {got['byIdSize']} · sections total {got['sectionSum']} · blocks {got['blocks']}",
            )
            # Paragraph splitting has to be visible in the result: the title text is in
            # the document and no single block is a giant blob (the chunk rule holds).
            check("the paper's title survives into a block", "Attention Is All You Need" in got["title"], f"{len(got['title'])} chars")
            check("blocks are paragraph-sized, not blobs", 0 < got["longest"] <= 1500, f"longest block {got['longest']} chars")
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
                    const panel = document.getElementById('tracky-root')?.shadowRoot?.querySelector('.panel');
                    return { open: document.body.classList.contains('panel-open'),
                             pad: parseFloat(getComputedStyle(el).paddingRight),
                             panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0 }; }"""
            )
            check("the document slides out from under the open panel", shifted["open"] and shifted["pad"] > 300, f"padding-right {shifted['pad']}px")
            check(
                "the gap is measured from the panel, not hard-coded",
                shifted["panelW"] > 0 and abs(shifted["pad"] - (shifted["panelW"] + 16)) <= 2,
                f"panel {shifted['panelW']}px → gap {shifted['pad']}px",
            )
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

            # Reopen the panel through its own API (the close test above shut it), then
            # drive the real end-to-end path when the model route allows it: type a
            # question in the reused panel, click a result, and check the highlight
            # landed on the PDF's own text layer.
            page.evaluate("() => window.__tracky && window.__tracky.open()")
            time.sleep(0.5)
            page.evaluate(
                """() => { const i = document.getElementById('tracky-root').shadowRoot.querySelector('input'); i.focus(); }"""
            )
            before = page.evaluate("() => document.getElementById('tracky-root').shadowRoot.querySelector('#t-status')?.textContent ?? ''")
            page.keyboard.type("what is the main contribution of this paper?", delay=8)
            page.keyboard.press("Enter")
            state = {}
            for _ in range(150):
                state = page.evaluate(
                    """() => { const r = document.getElementById('tracky-root').shadowRoot;
                        return { status: r.querySelector('#t-status')?.textContent ?? '', hits: r.querySelectorAll('.hit').length }; }"""
                )
                st = (state.get("status") or "").lower()
                moved = state.get("status") != before
                if moved and st and "searching" not in st and "reading" not in st:
                    break
                time.sleep(0.4)
            if "rate-limited" in (state.get("status") or "").lower():
                check("a real search inside the PDF (blocked: model route rate-limited)", True, "re-run when the window opens")
            else:
                check("a real search runs inside the PDF", state.get("hits", 0) >= 1, f"{state.get('hits')} hit(s) · {(state.get('status') or '')[:70]}")
                clicked = page.evaluate(
                    """() => { const r = document.getElementById('tracky-root').shadowRoot;
                        const b = r.querySelector('.hit .jump'); if (!b) return false; b.click(); return true; }"""
                )
                time.sleep(0.8)
                painted = page.evaluate("() => CSS.highlights.has('tracky-hl')")
                check("clicking a result highlights it on the PDF itself", clicked and painted, f"clicked={clicked} painted={painted}")
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

            # The lazy-memory claim, measured at the *end* of the document: scroll all
            # the way down, and the pages left behind must have given their buffers back.
            page.evaluate(
                """() => {
                    const wraps = document.querySelectorAll('#pages .page');
                    const last = wraps[wraps.length - 1];
                    if (last) last.scrollIntoView({ block: 'end' });
                }"""
            )
            page.wait_for_timeout(2500)
            mem = page.evaluate(
                """() => {
                    const cs = [...document.querySelectorAll('canvas')];
                    let allocated = 0, total = 0;
                    for (const c of cs) {
                        if (c.width > 0 && c.height > 0) { allocated++; total += c.width * c.height; }
                    }
                    return { canvases: cs.length, allocated, mb: Math.round((total * 4) / 1048576), firstFreed: cs[0] ? cs[0].width === 0 && cs[0].height === 0 : false };
                }"""
            )
            check(
                "pages left behind give their pixel buffers back",
                mem["firstFreed"] and mem["allocated"] < mem["canvases"] and mem["allocated"] <= 8,
                f"{mem['allocated']} of {mem['canvases']} canvases allocated (~{mem['mb']} MB); first page freed: {mem['firstFreed']}",
            )

            # The reader must never show a blank page: scroll away from page 1 (which
            # frees its buffer), then come back to it and the canvas must repaint.
            page.evaluate(
                """() => {
                    const wraps = document.querySelectorAll('#pages .page');
                    wraps[wraps.length - 1]?.scrollIntoView({ block: 'end' });
                }"""
            )
            page.wait_for_timeout(1500)
            page.evaluate("() => { document.querySelectorAll('#pages .page')[0]?.scrollIntoView({ block: 'start' }); }")
            page.wait_for_timeout(2500)
            back = page.evaluate(
                """() => {
                    const wraps = [...document.querySelectorAll('#pages .page')];
                    const mid = window.innerHeight / 2;
                    let inView = null;
                    for (const w of wraps) {
                        const r = w.getBoundingClientRect();
                        if (r.top <= mid && r.bottom >= mid) { inView = w; break; }
                    }
                    const c = inView?.querySelector('canvas');
                    return {
                        page: inView ? Number(inView.dataset.page) : null,
                        painted: !!(c && c.width > 0 && c.height > 0),
                        paintError: inView?.dataset.paintError ?? '',
                    };
                }"""
            )
            check(
                "the page you come back to repaints",
                back["painted"],
                f"page {back['page']} in view · painted={back['painted']} · error={back['paintError'][:60] or 'none'}",
            )

            # ---- second document: a two-column paper (the layout that breaks naive
            # PDF readers — columns must not be interleaved into one block) --------
            twocol = EXT / "tests" / "twocol.pdf"
            if twocol.exists():
                p2 = ctx.new_page()
                errs2: list[str] = []
                p2.on("pageerror", lambda e: errs2.append(str(e)))
                p2.goto(f"chrome-extension://{ext_id}/pdf.html?src=chrome-extension://{ext_id}/tests/twocol.pdf&name=bert.pdf", wait_until="domcontentloaded", timeout=60000)
                ok2 = False
                for _ in range(240):
                    ok2 = p2.evaluate("() => window.__trackyPdfReady === true")
                    if ok2:
                        break
                    time.sleep(0.25)
                check("a two-column paper renders too", ok2, f"{p2.evaluate('() => window.__trackyPdfStats?.pages')} pages")
                if ok2:
                    cols = p2.evaluate(
                        """() => {
                            const r = window.__trackyCollect();
                            const pageW = document.querySelector('.page')?.clientWidth ?? 1;
                            let worstGap = 0, mixed = 0, checked = 0, widest = 0;
                            for (const [, e] of r.byId) {
                                const spans = e.segments.map(s => s.node?.parentElement).filter(Boolean);
                                if (!spans.length) continue;
                                // x-intervals of every span in this block, merged
                                const iv = spans.map(s => {
                                    const l = parseFloat(s.style.left) || 0;
                                    return [l, l + s.getBoundingClientRect().width];
                                }).sort((a, b) => a[0] - b[0]);
                                const merged = [];
                                for (const [l, r2] of iv) {
                                    const last = merged[merged.length - 1];
                                    if (last && l <= last[1] + 1) last[1] = Math.max(last[1], r2);
                                    else merged.push([l, r2]);
                                }
                                checked++;
                                const width = merged[merged.length - 1][1] - merged[0][0];
                                widest = Math.max(widest, width / pageW);
                                // A gap between clusters means two columns were stitched together.
                                let gap = 0;
                                for (let i = 1; i < merged.length; i++) gap = Math.max(gap, merged[i][0] - merged[i - 1][1]);
                                const frac = gap / pageW;
                                if (frac > worstGap) worstGap = frac;
                                if (frac > 0.06) mixed++;
                            }
                            return { checked, worstGap: Math.round(worstGap * 100) / 100, mixed, widest: Math.round(widest * 100) / 100, blocks: r.blocks.length, byIdSize: r.byId.size, sectionSum: r.sections.reduce((a, s) => a + s.count, 0), skipOk: r.stats.skipped === ((d) => d.short + d.dedupe + d.capped + d.cappedPages + d.pageErrors)(r.stats.skippedDetail), consideredOk: r.stats.skippedDetail.considered === r.stats.spans };
                        }"""
                    )
                    check("two-column pages produce blocks", cols["blocks"] >= 30, f"{cols['blocks']} blocks from {cols['checked']} checked")
                    check(
                        "no block stitches two columns together",
                        cols["mixed"] == 0,
                        f"{cols['mixed']} block(s) with a column gap; worst gap {int(cols['worstGap'] * 100)}% of page width; widest block {int(cols['widest'] * 100)}%",
                    )
                    check(
                        "the second document's counters agree too",
                        cols["byIdSize"] == cols["blocks"] and cols["sectionSum"] == cols["blocks"] and cols["skipOk"] and cols["consideredOk"],
                        f"byId {cols['byIdSize']} · sections {cols['sectionSum']} · blocks {cols['blocks']} · skip identity {cols['skipOk']} · considered identity {cols['consideredOk']}",
                    )
                    check("the two-column page has no JS errors", not errs2, "; ".join(errs2[:2])[:140])
        finally:
            ctx.close()

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    print(f"\n{passed}/{len(CHECKS)} checks passed — {'ALL GOOD' if passed == len(CHECKS) else 'FAILURES PRESENT'}")
    if passed != len(CHECKS):
        print(json.dumps([c for c in CHECKS if not c[1]], indent=1))
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
