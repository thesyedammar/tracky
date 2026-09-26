#!/usr/bin/env python3
"""Phase 8 proof — Tracky against a REAL React app (fixture: spikes/fixtures/react-app.html).

What it proves, with numbers instead of adjectives:
  1. Tracky reads and highlights inside a live React 18 tree (createRoot + useState).
  2. Tracky inserts/removes ZERO nodes inside the app root — the extension cannot
     disturb React's reconciliation (CSS Custom Highlight API paints, it never wraps).
  3. React keeps working after the extension touched the page (state update re-renders).
  4. A React re-render that leaves the matched text alone does not break the highlight.
  5. No page JS errors at any point.

Run: xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/react-survival.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "spikes" / "fixtures"
OUT = ROOT / "spikes" / "out"
HELPER = os.environ.get("TRACKY_HELPER", "http://127.0.0.1:4199")
QUERY = "security deposit"
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


def xdotool(*args: str) -> str:
    return subprocess.run(["xdotool", *args], capture_output=True, text=True).stdout.strip()


def press_shortcut(title_hint: str = "Tracky React survival fixture") -> bool:
    for _ in range(20):
        wid = (
            xdotool("search", "--onlyvisible", "--name", title_hint)
            or xdotool("search", "--onlyvisible", "--class", "chromium")
            or xdotool("search", "--onlyvisible", "--class", "google-chrome")
        )
        if wid:
            wid = wid.splitlines()[-1]
            xdotool("windowactivate", "--sync", wid)
            time.sleep(0.2)
            xdotool("key", "--clearmodifiers", "alt+k")
            return True
        time.sleep(0.25)
    return False


def read_status(page) -> str:
    return page.evaluate(
        "() => { const h = document.getElementById('tracky-root');"
        " const s = h && h.shadowRoot && h.shadowRoot.querySelector('#t-status');"
        " return s ? s.textContent : ''; }"
    )


def main() -> int:
    from playwright.sync_api import sync_playwright

    OUT.mkdir(parents=True, exist_ok=True)
    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/react-app.html"
    print(f"React fixture: {url}\nHelper: {HELPER}\n")

    profile = Path(tempfile.mkdtemp(prefix="tracky-react-"))
    errors: list[str] = []
    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                str(profile),
                headless=False,
                executable_path=find_chrome(),
                args=[
                    f"--disable-extensions-except={ROOT / 'extension'}",
                    f"--load-extension={ROOT / 'extension'}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--window-size=1400,1000",
                ],
                viewport={"width": 1400, "height": 1000},
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_selector("#root main", timeout=30000)  # React actually rendered
            page.wait_for_timeout(400)
            check("React app rendered its own tree (createRoot)", page.evaluate("() => !!document.querySelector('#root main h1')"))

            # Watch the app root: any node the extension adds/removes here is a bug.
            page.evaluate(
                "() => { const root = document.getElementById('root');"
                " window.__trackyMut = { childList: 0, attr: 0, added: [], removed: [] };"
                " window.__trackyObs = new MutationObserver((recs) => {"
                "   for (const r of recs) {"
                "     if (r.type === 'childList') { window.__trackyMut.childList += r.addedNodes.length + r.removedNodes.length;"
                "       r.addedNodes.forEach((n) => window.__trackyMut.added.push(n.nodeName));"
                "       r.removedNodes.forEach((n) => window.__trackyMut.removed.push(n.nodeName)); }"
                "     else window.__trackyMut.attr += 1; } });"
                " window.__trackyObs.observe(root, { childList: true, subtree: true, attributes: true }); }"
            )

            time.sleep(0.3)
            gesture = press_shortcut()
            check("Alt+K gesture delivered (xdotool)", gesture)
            if not gesture:
                return finish(ctx)

            page.wait_for_timeout(700)
            panel = page.evaluate(
                "() => { const h = document.getElementById('tracky-root');"
                " return !!(h && h.shadowRoot && h.shadowRoot.querySelector('input')); }"
            )
            check("panel opened on the React page", panel)
            if not panel:
                return finish(ctx)

            page.evaluate(
                "() => { const h = document.getElementById('tracky-root');"
                " const i = h && h.shadowRoot && h.shadowRoot.querySelector('input');"
                " if (i) { i.focus(); i.select(); } }"
            )
            page.keyboard.type(QUERY, delay=15)
            page.keyboard.press("Enter")

            hits = 0
            for _ in range(400):  # real helper pass over a real page
                hits = page.evaluate(
                    "() => { const h = document.getElementById('tracky-root');"
                    " const s = h && h.shadowRoot; return s ? s.querySelectorAll('.hit').length : 0; }"
                )
                if hits:
                    break
                time.sleep(0.1)
            check("meaning search works inside the React tree", hits >= 1, f"{hits} matches · {read_status(page)[:70]}")

            # Jump → highlight via CSS Custom Highlight API (no DOM wrapping).
            page.evaluate(
                "() => document.getElementById('tracky-root').shadowRoot.querySelector('.hit .jump').click()"
            )
            page.wait_for_timeout(900)
            hl = page.evaluate(
                "() => { if (!CSS.highlights || !CSS.highlights.has('tracky-hl')) return '';"
                " const r = CSS.highlights.get('tracky-hl'); const arr = [...r];"
                " return arr.length ? arr[0].toString() : ''; }"
            )
            check(
                "highlight lands on the exact sentence (page world reads it)",
                QUERY in hl.lower(),
                hl[:90],
            )

            mut = page.evaluate("() => window.__trackyMut")
            check(
                "extension added/removed ZERO nodes inside the React root",
                mut["childList"] == 0,
                json.dumps(mut)[:160],
            )
            check(
                "no page JavaScript errors",
                not errors,
                "; ".join(errors)[:160],
            )

            # React must still be able to re-render after all of that.
            page.click("#bump")
            page.wait_for_timeout(400)
            proof = page.evaluate("() => document.getElementById('proof')?.textContent ?? ''")
            check("React re-rendered after the extension touched the page", "re-rendered 1 time" in proof, proof[:110])

            # The matched paragraphs are untouched by that re-render — highlight must still work.
            hl2 = page.evaluate(
                "() => { if (!CSS.highlights || !CSS.highlights.has('tracky-hl')) return '';"
                " const arr = [...CSS.highlights.get('tracky-hl')]; return arr.length ? arr[0].toString() : ''; }"
            )
            page.evaluate(
                "() => document.getElementById('tracky-root').shadowRoot.querySelector('.hit .jump').click()"
            )
            page.wait_for_timeout(700)
            hl3 = page.evaluate(
                "() => { if (!CSS.highlights || !CSS.highlights.has('tracky-hl')) return '';"
                " const arr = [...CSS.highlights.get('tracky-hl')]; return arr.length ? arr[0].toString() : ''; }"
            )
            check(
                "re-jump after a React re-render still highlights the same sentence",
                QUERY in hl3.lower(),
                hl3[:90],
            )
            page.screenshot(path=str(OUT / "tracky-react.png"))
            return finish(ctx)
    finally:
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


def finish(ctx) -> int:
    try:
        ctx.close()
    except Exception:
        pass
    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = [name for name, ok, _ in CHECKS if not ok]
    print(f"\n{'ALL CHECKS PASSED' if not failed else 'FAILURES'} — {passed}/{len(CHECKS)}")
    for name in failed:
        print(f"  FAILED: {name}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
