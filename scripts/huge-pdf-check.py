#!/usr/bin/env python3
"""Acceptance check for a big or dense PDF: the whole-document search must complete.

Why this exists: a 58-page paper failed with "search failed — Jev answered HTTP 400".
The route's own answer was {"detail":{"error_type":"max_tokens_exceeded"}} — its
80-passage request measured 237,806 body chars ≈ 71k tokens against the model's 64k
input cap. The engine now sizes every request (MAX_BODY_CHARS) and halves a chunk when
the route still says "too big", so any document finishes. This script proves it end to
end on a real file, in either mode, with the real UI.

Run:
  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/huge-pdf-check.py paper.pdf
  ... --mode direct            # exercises the extension's own engine (no helper)
  ... --query "your question"  # default: what is the main contribution of this paper?
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
TESTS = EXT / "tests"
JEV_ORIGIN = "https://opencode.ai/*"


def find_chrome() -> str:
    cands = sorted(Path.home().glob(".cache/ms-playwright/chromium-*/chrome-linux64/chrome"))
    if not cands:
        sys.exit("no Playwright Chrome found")
    return str(cands[-1])


def env_key() -> str:
    """The key from server/.env — read, never printed."""
    text = (ROOT / "server" / ".env").read_text()
    m = re.search(r"^JEV_API_KEY=(.+)$", text, re.M)
    if not m:
        sys.exit("no JEV_API_KEY in server/.env")
    return m.group(1).strip()


def granted_copy(tmp: str) -> Path:
    """The same code with the host permission already granted — the state Chrome is in
    after the user accepts the prompt (a prompt is browser chrome we cannot click)."""
    dst = Path(tmp) / "extension-granted"
    shutil.copytree(EXT, dst)
    mf = json.loads((dst / "manifest.json").read_text())
    mf["host_permissions"] = [JEV_ORIGIN]
    (dst / "manifest.json").write_text(json.dumps(mf, indent=2) + "\n")
    return dst


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--mode", choices=["helper", "direct"], default="helper")
    ap.add_argument("--query", default="what is the main contribution of this paper?")
    ap.add_argument("--budget", type=int, default=180, help="seconds to wait for the search")
    args = ap.parse_args()

    src = Path(args.pdf).expanduser().resolve()
    if not src.is_file():
        sys.exit(f"not a file: {src}")
    TMP_PDF = TESTS / "__huge-check.pdf"
    shutil.copy(src, TMP_PDF)
    tmp = tempfile.mkdtemp(prefix="tracky-huge-")
    ext_dir = EXT if args.mode == "helper" else granted_copy(tmp)
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(Path(tmp) / "profile"),
                executable_path=find_chrome(),
                headless=False,
                viewport={"width": 1280, "height": 900},
                args=[
                    "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
                    "--no-default-browser-check", "--window-size=1280,900", "--window-position=0,0",
                    f"--disable-extensions-except={ext_dir}", f"--load-extension={ext_dir}",
                ],
            )
            try:
                worker = None
                for _ in range(600):  # cold Chrome on a loaded box: 60 s before calling it dead
                    if ctx.service_workers:
                        worker = ctx.service_workers[0]
                        break
                    time.sleep(0.1)
                check("the extension loads and its worker runs", worker is not None)
                if worker is None:
                    return 1
                ext_id = worker.url.split("/")[2]

                if args.mode == "direct":
                    # The real options UI: pick Direct, paste the key, wait for the save.
                    opts = ctx.new_page()
                    opts.goto(f"chrome-extension://{ext_id}/options.html", wait_until="load")
                    opts.wait_for_timeout(1000)
                    opts.check("#mode-direct")
                    opts.fill("#dkey", env_key())
                    opts.dispatch_event("#dkey", "change")
                    opts.wait_for_timeout(500)
                    saved = worker.evaluate("async () => (await chrome.storage.local.get('trackyOpts')).trackyOpts")
                    check("direct mode is on with a key stored", (saved or {}).get("mode") == "direct" and bool((saved or {}).get("directKey")))
                    opts.close()
                else:
                    check("the helper is up for helper mode", helper_health(), "http://127.0.0.1:4199")

                page = ctx.new_page()
                errors: list[str] = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                src_url = f"chrome-extension://{ext_id}/tests/{TMP_PDF.name}"
                page.goto(f"chrome-extension://{ext_id}/pdf.html?src={src_url}&name={TMP_PDF.name}", wait_until="load")

                pages = 0
                for _ in range(1200):  # a long document takes a while to extract
                    pages = page.evaluate("() => document.querySelectorAll('.page').length")
                    if page.evaluate("() => window.__trackyPdfReady === true") and pages >= 1:
                        break
                    time.sleep(0.5)
                check("the reader extracted the document", pages >= 1, f"{pages} page(s) rendered")

                stats = page.evaluate("() => window.__trackyCollect().stats")
                check(
                    "the document collects without touching the model",
                    stats.get("blocks", 0) >= 1,
                    f"{stats.get('blocks')} passages · {stats.get('chars')} chars · {pages} pages",
                )

                page.evaluate("() => window.__tracky && window.__tracky.open()")
                page.wait_for_timeout(500)
                page.evaluate("() => document.getElementById('tracky-root').shadowRoot.querySelector('input').focus()")
                page.keyboard.type(args.query, delay=6)
                page.keyboard.press("Enter")

                # Wait for the FINISHED shape ("N passages · M matches · T ms"), not for
                # "not searching": right after Enter the panel briefly says "showing that
                # sentence on the page", which is a jump message, not a result line.
                status, hits = "", 0
                deadline = time.time() + args.budget
                while time.time() < deadline:
                    state = page.evaluate(
                        """() => { const r = document.getElementById('tracky-root').shadowRoot;
                            return { status: r.querySelector('#t-status')?.textContent ?? '',
                                     hits: r.querySelectorAll('.hit').length }; }"""
                    )
                    status, hits = state["status"], state["hits"]
                    if re.match(r"^\d+ passages · \d+ match", status or ""):
                        break
                    if "failed" in (status or "").lower():
                        break  # a real failure: stop waiting, let the checks report it
                    time.sleep(0.5)

                print(f"\n  status: {status[:140]}")
                check("the search finished (no 400, no 'too big')", "400" not in status and "too big" not in status and "failed" not in status.lower(), status[:110])
                check("the whole document was swept in passes", re.match(r"^\d+ passages · \d+ match", status) is not None, status[:80])
                check("results came back", hits >= 1, f"{hits} hit(s)")
                check("no console errors", not errors, errors[0][:90] if errors else "")

                shot = ROOT / "spikes" / "out" / f"huge-pdf-{args.mode}.png"
                page.screenshot(path=str(shot))
                print(f"  screenshot: {shot}")
            finally:
                ctx.close()
    finally:
        TMP_PDF.unlink(missing_ok=True)
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{'ALL GOOD' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 0 if not failures else 1


def helper_health(timeout: float = 2.0) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen("http://127.0.0.1:4199/api/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())
