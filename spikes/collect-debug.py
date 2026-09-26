#!/usr/bin/env python3
"""Debug the page collector on any URL: prints stats, block sizes, and samples.

Runs collect.js directly in the page (it is pure DOM code, no chrome.* APIs).

Run: python3 spikes/collect-debug.py "https://en.wikipedia.org/wiki/Rental_agreement"
Env: TRACKY_CHROME to override the browser binary.
"""
import os
import shutil
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = sys.argv[1] if len(sys.argv) > 1 else "https://en.wikipedia.org/wiki/Rental_agreement"


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


def main() -> None:
    src = (ROOT / "extension" / "collect.js").read_text()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=find_chrome(), headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(URL, wait_until="load")
        page.wait_for_timeout(800)
        out = page.evaluate(
            """(src) => {
                eval(src);
                const r = window.__trackyCollect();
                const sizes = r.blocks.map((b) => b.text.length).sort((a, b) => b - a);
                return {
                    stats: r.stats,
                    blocks: r.blocks.length,
                    chars: sizes.reduce((a, b) => a + b, 0),
                    biggest: sizes.slice(0, 5),
                    samples: r.blocks.slice(0, 4).map((b) => b.text.slice(0, 90).replace(/\\s+/g, " ")),
                };
            }""",
            src,
        )
        print("stats:", out["stats"])
        print("blocks:", out["blocks"], "chars:", out["chars"], "biggest:", out["biggest"])
        for s in out["samples"]:
            print("  ·", s)
        browser.close()


if __name__ == "__main__":
    main()
