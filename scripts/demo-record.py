#!/usr/bin/env python3
"""Record the 60-second demo (Phase 15.1) — real Chrome, real page, real search.

Playwright records the browser window while this script drives the product the way a
person would: press Alt+K on a real Wikipedia article, ask a question in plain words,
watch the quotes arrive, click one to see it glow on the page, scope to a section,
then open a PDF and do the same inside it. The result is a .webm that ffmpeg turns
into an mp4 + gif for the README and the launch post.

If the model route is rate-limited the search steps are skipped and the script says so
instead of recording a broken demo.

Run:  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/demo-record.py
Out:  spikes/out/demo/*.webm  (+ docs/media/tracky-demo.mp4 and .gif via ffmpeg)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
OUT = ROOT / "spikes" / "out" / "demo"
MEDIA = ROOT / "docs" / "media"
URL = os.environ.get("TRACKY_DEMO_URL", "https://en.wikipedia.org/wiki/Lease")
QUERY = os.environ.get("TRACKY_DEMO_QUERY", "when do I get my deposit back?")


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
    raise SystemExit("no Chrome found")


def panel_state(page) -> dict:
    return page.evaluate(
        """() => { const h = document.getElementById('tracky-root');
            if (!h?.shadowRoot) return { open: false };
            const r = h.shadowRoot;
            const wrap = r.querySelector('.wrap');
            return {
                open: !!wrap && wrap.style.display !== 'none',
                status: r.querySelector('#t-status')?.textContent ?? '',
                hits: r.querySelectorAll('.hit').length,
                card: !!r.querySelector('.card'),
                scope: r.querySelectorAll('.scope button').length,
            }; }"""
    )


def wait_status(page, timeout_s: int = 60) -> dict:
    """Wait until the panel stops saying 'searching…' — returns the final state."""
    deadline = time.time() + timeout_s
    last = {}
    while time.time() < deadline:
        last = panel_state(page)
        st = (last.get("status") or "").lower()
        if st and "searching" not in st and "reading" not in st and "checking" not in st:
            return last
        time.sleep(0.4)
    return last


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tracky-demo-profile-") as profile, sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=profile,
            executable_path=find_chrome(),
            headless=False,
            viewport={"width": 1280, "height": 860},
            record_video_dir=str(OUT),
            record_video_size={"width": 1280, "height": 860},
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=1280,880",
                "--window-position=0,0",
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
            ],
        )
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            time.sleep(2.0)

            # A real OS-level gesture grants activeTab — the same shortcut a user presses.
            subprocess.run(["xdotool", "key", "--clearmodifiers", "alt+k"], check=False)
            time.sleep(1.4)
            st = panel_state(page)
            if not st.get("open"):
                print("panel did not open — aborting before recording junk")
                return 1

            # Type the question like a person, slowly enough to read on video.
            box = page.evaluate(
                """() => { const r = document.getElementById('tracky-root').shadowRoot;
                    const i = r.querySelector('input'); i.focus(); return true; }"""
            )
            assert box
            for chunk in [QUERY[i : i + 6] for i in range(0, len(QUERY), 6)]:
                page.keyboard.type(chunk, delay=70)
            time.sleep(0.4)
            page.keyboard.press("Enter")
            st = wait_status(page, 70)
            print("after search:", st)

            if "rate-limited" in (st.get("status") or "").lower():
                print("model route is rate-limited — no demo recorded (the panel is honest about it)")
                return 2
            if not st.get("hits"):
                print("no hits — nothing worth recording")
                return 1

            time.sleep(2.5)  # let the quotes be read

            # Click the top quote: the page scrolls and the sentence glows.
            page.evaluate(
                """() => { const r = document.getElementById('tracky-root').shadowRoot;
                    r.querySelector('.hit .jump')?.click(); }"""
            )
            time.sleep(2.8)

            # Scope to a section, if the page offers one.
            scoped = page.evaluate(
                """() => { const r = document.getElementById('tracky-root').shadowRoot;
                    const b = r.querySelector('.scope button'); if (!b) return false; b.click(); return true; }"""
            )
            if scoped:
                st = wait_status(page, 60)
                print("after scope:", st)
                time.sleep(2.2)

            # Answer card + export button, held for the viewer.
            page.evaluate(
                """() => { const r = document.getElementById('tracky-root').shadowRoot;
                    const el = r.querySelector('.card'); el?.scrollIntoView({ block: 'nearest' }); }"""
            )
            time.sleep(2.0)

            # PDF mode: the same panel inside a rendered PDF.
            pdf_tab = ctx.new_page()
            ext_id = ctx.service_workers[0].url.split("/")[2] if ctx.service_workers else ""
            if ext_id:
                pdf_tab.goto(f"chrome-extension://{ext_id}/pdf.html?src=chrome-extension://{ext_id}/tests/sample.pdf&name=attention.pdf", wait_until="domcontentloaded")
                for _ in range(120):
                    if pdf_tab.evaluate("() => window.__trackyPdfReady === true"):
                        break
                    time.sleep(0.25)
                time.sleep(1.0)
                pdf_tab.evaluate("() => { const i = document.getElementById('tracky-root').shadowRoot.querySelector('input'); i.focus(); }")
                for chunk in ["explain the ", "attention ", "mechanism"]:
                    pdf_tab.keyboard.type(chunk, delay=70)
                time.sleep(0.3)
                pdf_tab.keyboard.press("Enter")
                st = wait_status(pdf_tab, 70)
                print("pdf search:", st)
                time.sleep(2.4)
                if st.get("hits"):
                    pdf_tab.evaluate(
                        """() => { const r = document.getElementById('tracky-root').shadowRoot;
                            r.querySelector('.hit .jump')?.click(); }"""
                    )
                    # Hold on the result — and never end the take on a page whose canvas is
                    # still repainting (a lazy reader can show a blank page for a moment).
                    for _ in range(20):
                        painted = pdf_tab.evaluate(
                            """() => {
                                const mid = window.innerHeight / 2;
                                for (const w of document.querySelectorAll('#pages .page')) {
                                    const r = w.getBoundingClientRect();
                                    if (r.top <= mid && r.bottom >= mid) {
                                        const c = w.querySelector('canvas');
                                        return !!(c && c.width > 0 && c.height > 0);
                                    }
                                }
                                return false;
                            }"""
                        )
                        if painted:
                            break
                        time.sleep(0.5)
                    time.sleep(4.5)  # let the quote and the highlight be read
        finally:
            ctx.close()

    videos = sorted(OUT.glob("*.webm"), key=lambda p: p.stat().st_mtime)
    if not videos:
        print("no video written")
        return 1
    MEDIA.mkdir(parents=True, exist_ok=True)
    mp4 = MEDIA / "tracky-demo.mp4"
    gif = MEDIA / "tracky-demo.gif"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(videos[-1]), "-movflags", "+faststart", "-pix_fmt", "yuv420p", str(mp4)],
        check=False,
        capture_output=True,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(videos[-1]), "-vf", "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", str(gif)],
        check=False,
        capture_output=True,
    )
    print(f"video: {videos[-1]}")
    for f in (mp4, gif):
        print(f"{'✓' if f.exists() else '✗'} {f} {f.stat().st_size // 1024 if f.exists() else 0} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
