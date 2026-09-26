#!/usr/bin/env python3
"""Load the Tracky extension in a real Chromium and prove the panel works live.

The gesture is REAL: Chrome runs headed inside Xvfb and xdotool presses the
actual Alt+K shortcut at the OS level — that is what grants `activeTab`, so the
whole product path is exercised (gesture → action.onClicked → inject content.js
→ panel → ping/pong → live helper reply). The version/model assertions compare
against the LIVE helper's own /api/health payload — nothing is hardcoded.

Run:  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/ext-smoke.py
Env:  TRACKY_SMOKE_URL   override the page (default: local tos.html fixture)
      TRACKY_CHROME      override the Chrome binary
Exit: 0 = all checks passed, 1 = something failed (details printed).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
FIXTURES = ROOT / "spikes" / "fixtures"
OUT = ROOT / "spikes" / "out"
HELPER = "http://127.0.0.1:4199/api/health"

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


def find_chrome() -> str:
    """Locate a Chromium/Chrome binary: env override, playwright cache, or PATH."""
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


def press_shortcut(title_hint: str = "Tracky fixture") -> bool:
    """Focus the Chrome window at the X level and press Alt+K for real."""
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


def serve_fixtures() -> tuple[ThreadingHTTPServer, int]:
    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def read_status(page) -> str:
    return page.evaluate(
        "() => { const h = document.getElementById('tracky-root');"
        " const s = h && h.shadowRoot && h.shadowRoot.querySelector('#t-status');"
        " return s ? s.textContent : ''; }"
    )


def panel_visible(page) -> bool:
    return page.evaluate(
        "() => { const h = document.getElementById('tracky-root');"
        " const w = h && h.shadowRoot && h.shadowRoot.querySelector('.wrap');"
        " return !!w && w.style.display !== 'none'; }"
    )


WAIT_VISIBLE = (
    "() => { const h = document.getElementById('tracky-root');"
    " const w = h && h.shadowRoot && h.shadowRoot.querySelector('.wrap');"
    " return !!w && w.style.display !== 'none'; }"
)

WAIT_HIDDEN = (
    "() => { const h = document.getElementById('tracky-root');"
    " const w = h && h.shadowRoot && h.shadowRoot.querySelector('.wrap');"
    " return !!w && w.style.display === 'none'; }"
)


def run_checks(pw, profile: Path, page_url: str) -> None:
    ctx = pw.chromium.launch_persistent_context(
        user_data_dir=str(profile),
        executable_path=find_chrome(),
        headless=False,  # headed inside Xvfb — the toolbar + accelerators are real
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
        for _ in range(50):
            if ctx.service_workers:
                worker = ctx.service_workers[0]
                break
            time.sleep(0.1)
        check("extension service worker is alive", worker is not None)
        if worker is None:
            return
        check("extension id resolved", bool(worker.url.split("/")[2]), worker.url.split("/")[2])

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(page_url, wait_until="load")
        title = page.title()
        check("page loaded", bool(title), title)
        page.click("body")
        time.sleep(0.3)  # OS-level gesture timing: let the window settle before xdotool
        hint = title.split("—")[0].split("|")[0].strip()[:24]

        # --- the real gesture: OS-level Alt+K inside the Xvfb display ---
        gesture = press_shortcut(hint)
        check("Alt+K gesture delivered (xdotool)", gesture)

        host_present = False
        try:
            page.wait_for_function("() => !!document.getElementById('tracky-root')", timeout=8000)
            host_present = True
        except Exception:
            pass
        check("gesture granted activeTab and injected the panel", host_present)
        check("panel is visible", host_present and panel_visible(page))
        if not host_present:
            return

        text = ""
        for _ in range(60):  # up to ~6s for the ping round-trip
            text = read_status(page)
            if text and "checking" not in text:
                break
            time.sleep(0.1)
        check("panel shows the live helper reply", "helper" in text and "ready" in text, text)
        try:
            health = json.loads(urllib.request.urlopen(HELPER, timeout=3).read())
        except Exception as err:
            health = None
            check("live helper health reachable for comparison", False, str(err))
        if health:
            check("panel text carries the live helper version", health["version"] in text, f"live {health['version']}")
            check("panel text carries the live helper model", health["model"] in text, f"live {health['model']}")

        shot = OUT / "tracky-panel.png"
        page.screenshot(path=str(shot))
        check("screenshot saved", shot.exists(), str(shot))

        # Esc closes; a second real gesture reopens.
        page.keyboard.press("Escape")
        try:
            page.wait_for_function(WAIT_HIDDEN, timeout=5000)
            closed = True
        except Exception:
            closed = False
        check("Esc closes the panel", closed)
        second = press_shortcut(hint)
        try:
            page.wait_for_function(WAIT_VISIBLE, timeout=8000)
            reopened = True
        except Exception:
            reopened = False
        check("second Alt+K reopens the panel", second and reopened)

        # unsupported page: file:// gets the × badge and no panel
        page.goto((FIXTURES / "tos.html").as_uri(), wait_until="load")
        file_gesture = press_shortcut("Car Rental Agreement")
        badge = ""
        for _ in range(20):
            badge = worker.evaluate(
                """async () => {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    return chrome.action.getBadgeText({ tabId: tab.id });
                }"""
            )
            if badge == "×":
                break
            time.sleep(0.1)
        check("file:// gesture delivered", file_gesture)
        check("unsupported page shows the × badge", badge == "×", f"badge={badge!r}")
        check("no panel injected on file://", page.evaluate("!document.getElementById('tracky-root')"))
    finally:
        ctx.close()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="tracky-profile-"))
    httpd, port = serve_fixtures()
    page_url = os.environ.get("TRACKY_SMOKE_URL") or f"http://127.0.0.1:{port}/tos.html"
    try:
        with sync_playwright() as pw:
            run_checks(pw, profile, page_url)
    finally:
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    total = len(CHECKS)
    print(json.dumps({"checks": total, "passed": passed, "results": CHECKS}, indent=2))
    print(f"\n{'ALL CHECKS PASSED' if passed == total else 'FAILURES PRESENT'} — {passed}/{total}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
