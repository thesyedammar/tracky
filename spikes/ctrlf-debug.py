#!/usr/bin/env python3
"""Debug probe: does Ctrl+F reach the page world at all, and does the panel open?"""
from __future__ import annotations

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


def find_chrome() -> str:
    for pattern in ("chromium-*/chrome-linux64/chrome", "chromium-*/chrome-linux/chrome"):
        for cand in sorted(Path.home().glob(f".cache/ms-playwright/{pattern}")):
            if cand.exists():
                return str(cand)
    return shutil.which("google-chrome") or shutil.which("chromium") or ""


def xdotool(*args: str) -> str:
    return subprocess.run(["xdotool", *args], capture_output=True, text=True).stdout.strip()


def main() -> int:
    from playwright.sync_api import sync_playwright

    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    profile = Path(tempfile.mkdtemp(prefix="tracky-ctrlF-"))
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
            page.goto(f"http://127.0.0.1:{port}/tos.html", wait_until="load")
            # Page-world probe: did the renderer receive ctrl+f, and was it prevented?
            page.evaluate(
                "() => { window.__probe = { seen: 0, prevented: 0 };"
                " document.addEventListener('keydown', (e) => {"
                "   if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {"
                "     window.__probe.seen += 1;"
                "     window.__probe.key = e.key;"
                "     window.__probe.target = (e.target && e.target.tagName) || '?';"
                "   }"
                " }, true);"
                " document.addEventListener('keydown', (e) => {"
                "   if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && e.defaultPrevented) window.__probe.prevented += 1;"
                " }, false); }"
            )
            time.sleep(0.4)
            wid = xdotool("search", "--onlyvisible", "--name", "Tracky") or xdotool("search", "--onlyvisible", "--class", "chromium")
            print("window id:", wid)
            if wid:
                xdotool("windowactivate", "--sync", wid.splitlines()[-1])
                time.sleep(0.3)
                xdotool("key", "--clearmodifiers", "ctrl+f")
            time.sleep(1.0)
            print("after xdotool ctrl+f:", page.evaluate("() => window.__probe"))

            # (b) does xdotool deliver ANY key to the renderer in this Xvfb setup?
            page.evaluate("() => { const i = document.createElement('input'); i.id = 'kb'; document.body.appendChild(i); i.focus(); }")
            if wid:
                xdotool("key", "--clearmodifiers", "a")
            time.sleep(0.5)
            typed = page.evaluate("() => document.getElementById('kb').value")
            print("xdotool plain key into focused input:", repr(typed))

            # (c) the renderer path a real user's Ctrl+F takes once Chrome hands it over
            page.evaluate("() => document.getElementById('kb').blur()")
            page.keyboard.press("Control+f")
            time.sleep(0.8)
            print("after CDP Control+f:", page.evaluate("() => window.__probe"))
            panel = page.evaluate(
                "() => { const h = document.getElementById('tracky-root');"
                " if (!h || !h.shadowRoot) return { host: !!h, shadow: false };"
                " const w = h.shadowRoot.querySelector('.wrap');"
                " return { host: true, shadow: true, display: w ? w.style.display : 'n/a',"
                "   inputFocused: h.shadowRoot.activeElement === h.shadowRoot.querySelector('input') }; }"
            )
            print("panel:", panel)
            page.screenshot(path=str(ROOT / "spikes" / "out" / "ctrlF-debug.png"))
            ctx.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
