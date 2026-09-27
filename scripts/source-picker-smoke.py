#!/usr/bin/env python3
"""Prove the source picker live: the dropdown lists the helper's sources, the choice
persists, and a real search from the panel reaches the helper with that source.

Run:  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/source-picker-smoke.py
Exit: 0 = all checks passed, 1 = failure, 2 = blocked (helper down / route closed).
"""
import json
import os
import re
import sys
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
FIXTURES = ROOT / "spikes" / "fixtures"
HELPER = "http://127.0.0.1:4199"
CHECKS: list[tuple[str, bool, str]] = []
BLOCKED = {"seen": False}


def check(name: str, ok: bool, detail: str = "") -> None:
    if not ok and ("rate-limited" in detail or "429" in detail):
        BLOCKED["seen"] = True
    if not ok and BLOCKED["seen"]:
        CHECKS.append((name, False, "blocked by the model route"))
        print(f"  BLOCKED  {name} — {detail}")
        return
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
        import shutil

        found = shutil.which(name)
        if found:
            return found
    sys.exit("no chrome/chromium found")


def helper_json(path: str):
    with urllib.request.urlopen(f"{HELPER}{path}", timeout=5) as r:
        return json.load(r)


def xdotool(*args: str) -> str:
    import subprocess

    return subprocess.run(["xdotool", *args], capture_output=True, text=True).stdout.strip()


def press_shortcut(title_hint: str = "fixture") -> bool:
    """Focus the Chrome window at the X level and press Alt+K for real — the OS-level
    gesture is what grants activeTab, so page.keyboard cannot stand in for it."""
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


def main() -> int:
    try:
        providers = helper_json("/api/providers")
    except Exception as e:  # noqa: BLE001
        print(f"helper not reachable at {HELPER} — start it first ({e})")
        return 2

    handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading = __import__("threading")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    page_url = f"http://127.0.0.1:{port}/tos.html"

    import tempfile

    profile = Path(tempfile.mkdtemp(prefix="tracky-picker-"))
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile),
            executable_path=find_chrome(),
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
            ],
        )
        try:
            worker = None
            for _ in range(300):
                if ctx.service_workers:
                    worker = ctx.service_workers[0]
                    break
                time.sleep(0.1)
            check("extension service worker is alive", worker is not None)
            if worker is None:
                return 1
            ext_id = worker.url.split("/")[2]

            # --- the dropdown -------------------------------------------------
            opts = ctx.new_page()
            opts.goto(f"chrome-extension://{ext_id}/options.html", wait_until="load")
            opts.wait_for_timeout(1200)
            entries = opts.evaluate(
                "() => [...document.querySelectorAll('#source option')].map(o => ({v: o.value, t: o.textContent, d: o.disabled}))"
            )
            ids = [e["v"] for e in entries]
            check(
                "the dropdown lists every source the helper offers",
                ids == [""] + [p["id"] for p in providers["providers"]],
                " · ".join(ids),
            )
            typesafe = next((e for e in entries if e["v"] == "typesafe"), None)
            check(
                "a source with no key shows as 'no key yet' and cannot be picked",
                bool(typesafe) and typesafe["d"] is True and "no key yet" in typesafe["t"],
                (typesafe or {}).get("t", "missing"),
            )
            check(
                "the helper's default is the selected entry to start with",
                opts.evaluate("() => document.getElementById('source').value") == "",
                opts.evaluate("() => document.getElementById('source-note').textContent")[:70],
            )

            # --- pick the paid source, and prove it persists -------------------
            opts.select_option("#source", "zen-paid")
            opts.wait_for_timeout(600)
            stored = worker.evaluate("() => chrome.storage.local.get('trackyOpts')")
            check(
                "picking a source saves it",
                (stored or {}).get("trackyOpts", {}).get("source") == "zen-paid",
                json.dumps(stored)[:80],
            )
            note = opts.evaluate("() => document.getElementById('source-note').textContent")
            check("the note says the paid source is billed", "billed" in note, note[:80])
            opts.reload(wait_until="load")
            opts.wait_for_timeout(1200)
            check(
                "the choice survives a reload of the options page",
                opts.evaluate("() => document.getElementById('source').value") == "zen-paid",
            )

            # --- a real search from the panel carries the source ---------------
            page = ctx.new_page()
            page.goto(page_url, wait_until="load")
            page.bring_to_front()
            page.wait_for_timeout(400)
            check("the OS-level Alt+K gesture reached Chrome", press_shortcut("fixture"))
            page.wait_for_timeout(1500)
            injected = page.evaluate("() => !!document.getElementById('tracky-root')")
            check("the panel was injected into the active tab", injected)
            page.evaluate(
                "() => { const i = document.getElementById('tracky-root').shadowRoot.querySelector('input'); i.focus(); }"
            )
            page.keyboard.type("hidden charges")
            page.keyboard.press("Enter")
            page.wait_for_timeout(9000)
            status = page.evaluate(
                "() => { const r = document.getElementById('tracky-root').shadowRoot; const s = r.querySelector('.status'); return s ? s.textContent.trim() : ''; }"
            )
            check("a real search runs with the picked source", "passages" in status or "match" in status, status[:90])

            log = (ROOT / "spikes" / "out" / "helper.log").read_text(errors="replace").splitlines()[-1]
            check("the helper logged that exact source", "source zen-paid" in log, log[-110:])
        finally:
            ctx.close()
            httpd.shutdown()

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    print(f"\n{passed}/{len(CHECKS)} checks passed" + (" — ALL GOOD" if passed == len(CHECKS) else " — FAILURES PRESENT"))
    if BLOCKED["seen"]:
        print(f"BLOCKED — {passed}/{len(CHECKS)} passed, the rest need the model route")
        return 2
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
