#!/usr/bin/env python3
"""Prove direct mode live (0.7.0): paste a key, skip the helper, search for real.

Two builds are exercised, because the honest answer has two halves:

  A. the SHIPPED extension (no host permission of its own) — a direct search must
     stop at the permission gate with the exact honest message, never a mystery and
     never a request that leaves the machine;
  B. a GRANTED copy (host_permissions on the same code — the state after the user
     accepts Chrome's prompt) — the options page takes the key through the real UI,
     "Test key" makes one real call, and a real search on a real page lands with
     highlights while the HELPER IS STOPPED. That last part is the whole point of
     direct mode, so the harness stops the helper, verifies port 4199 is closed,
     searches, and starts the helper again.

The key is read from server/.env and never printed; the harness checks the key does
not appear in the page, the panel, the options page or the console.

Env:  TRACKY_DIRECT_URL    page to search (default: the local tos.html fixture)
      TRACKY_DIRECT_QUERY  question to ask (default: "hidden charges")
Run:  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/direct-smoke.py
Exit: 0 = all checks passed, 1 = failure, 2 = blocked (model route rate-limited).
"""

from __future__ import annotations

import json
import os
import re
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
ENV_PATH = ROOT / "server" / ".env"
HELPER = "http://127.0.0.1:4199"
JEV_ORIGIN = "https://opencode.ai/*"

CHECKS: list[tuple[str, bool, str]] = []
ROUTE_BLOCKED = {"seen": False}


# A failure inherits "blocked by the model route" only when it is route-shaped: its own
# detail names a quota window, or the route is already blocked AND the detail is a
# search/why failure. Anything else — a key leak, a UI assertion — stays a FAIL, so one
# 429 can never relabel an unrelated bug as "not our fault".
ROUTE_SHAPED = ("search failed", "why failed", "took too long", "no readable")


def check(name: str, ok: bool, detail: str = "") -> None:
    quota = "rate-limited" in detail or "429" in detail
    if not ok and quota:
        ROUTE_BLOCKED["seen"] = True
    blocked = not ok and (quota or (ROUTE_BLOCKED["seen"] and any(m in detail for m in ROUTE_SHAPED)))
    if blocked:
        CHECKS.append((name, False, "blocked by the model route"))
        print(f"  BLOCKED  {name}" + (f" — {detail}" if detail else ""))
        return
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


def read_key() -> str:
    """The key the user pastes — read locally, never printed, never echoed in a check."""
    for line in ENV_PATH.read_text().splitlines():
        if line.strip().startswith("JEV_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("no JEV_API_KEY in server/.env")


def helper_health(timeout: float = 2.0):
    try:
        with urllib.request.urlopen(f"{HELPER}/api/health", timeout=timeout) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001 — anything at all means "not answering"
        return None


def stop_helper() -> None:
    subprocess.run(["pkill", "-f", "[s]erver/server.mjs"], check=False)
    time.sleep(1.0)
    subprocess.run(["fuser", "-k", "4199/tcp"], capture_output=True, check=False)
    time.sleep(0.5)


def start_helper() -> bool:
    OUT.mkdir(parents=True, exist_ok=True)
    log = open(OUT / "helper.log", "ab")
    subprocess.Popen(  # noqa: S603 — the project's own start command, detached
        ["node", "server/server.mjs"],
        cwd=str(ROOT),
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    log.close()  # the child owns its own fd now; the parent must not leak the handle
    for _ in range(40):
        if helper_health():
            return True
        time.sleep(0.5)
    return False


def granted_copy(tmp: str) -> Path:
    """The same code with the host permission already granted — i.e. the state Chrome
    is in after the user accepts the prompt. A prompt itself is browser chrome the
    harness cannot click, so the accepted state is what gets exercised."""
    dst = Path(tmp) / "extension-granted"
    shutil.copytree(EXT, dst)
    mf = json.loads((dst / "manifest.json").read_text())
    mf["host_permissions"] = ["https://opencode.ai/*"]
    (dst / "manifest.json").write_text(json.dumps(mf, indent=2) + "\n")
    return dst


def launch(pw, profile: str, ext_dir: Path):
    return pw.chromium.launch_persistent_context(
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
            f"--disable-extensions-except={ext_dir}",
            f"--load-extension={ext_dir}",
        ],
    )


def press_shortcut(title_hint: str = "Tracky fixture") -> bool:
    for _ in range(20):
        wid = (
            subprocess.run(["xdotool", "search", "--onlyvisible", "--name", title_hint], capture_output=True, text=True).stdout.strip()
            or subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "chromium"], capture_output=True, text=True).stdout.strip()
            or subprocess.run(["xdotool", "search", "--onlyvisible", "--class", "google-chrome"], capture_output=True, text=True).stdout.strip()
        )
        if wid:
            wid = wid.splitlines()[-1]
            subprocess.run(["xdotool", "windowactivate", "--sync", wid], capture_output=True)
            time.sleep(0.2)
            subprocess.run(["xdotool", "key", "--clearmodifiers", "alt+k"], capture_output=True)
            return True
        time.sleep(0.25)
    return False


def panel_status(page) -> str:
    return page.evaluate(
        "() => { const h = document.getElementById('tracky-root');"
        " const s = h && h.shadowRoot && h.shadowRoot.querySelector('#t-status');"
        " return s ? s.textContent.trim() : ''; }"
    )


def run_panel_search(page, query: str, budget_s: int = 90) -> dict:
    """Type into the panel and press Enter — the real user path, through the worker.

    Waits for a FINISHED status, which is narrower than "anything that changed":
      · the finished line is exactly  "<n> passages · <m> matches · <ms> ms"
      · "searching <n> passages…" is progress, and the jump message ("showing that
        sentence on the page") is a transient after it — neither may end the wait.
    A failure line ends it too, so a blocked route fails fast instead of stalling.
    """
    page.evaluate(
        """(q) => {
            const root = document.getElementById('tracky-root').shadowRoot;
            const input = root.querySelector('input');
            input.focus();
            input.value = q;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }""",
        query,
    )
    finished = re.compile(r"^\d+ passages · \d+ match")
    bad = ("search failed", "rate-limited", "no readable", "permission", "timed out")
    started = time.time()
    seen: list[str] = []
    done = ""
    while time.time() - started < budget_s:
        time.sleep(0.4)
        status = panel_status(page)
        if status and (not seen or seen[-1] != status):
            seen.append(status)
        if status and (finished.search(status) or any(mark in status for mark in bad)):
            done = status
            break
    out = page.evaluate(
        """() => {
            const root = document.getElementById('tracky-root').shadowRoot;
            const hits = [...root.querySelectorAll('.hit')];
            return {
                hits: hits.length,
                sentences: hits.map(h => h.querySelector('.sentence')?.textContent?.trim() ?? ''),
                chips: root.querySelectorAll('.chip').length,
                highlights: {
                    all: (CSS.highlights && CSS.highlights.has('tracky-hl')) ? CSS.highlights.get('tracky-hl').size : 0,
                    now: (CSS.highlights && CSS.highlights.has('tracky-hl-now')) ? CSS.highlights.get('tracky-hl-now').size : 0,
                },
                text: root.textContent,
            };
        }"""
    )
    out["status"] = done or (seen[-1] if seen else "")
    out["statuses"] = seen[-3:]
    return out


def phase_a_shipped(pw, profile: str, page_url: str) -> None:
    """The extension as it ships: no Jev host permission, so a direct search must stop
    at the gate. Nothing may leave the machine, and the message must say why."""
    print("\nA. the shipped build (no host permission)")
    ctx = launch(pw, profile, EXT)
    try:
        worker = None
        for _ in range(300):
            if ctx.service_workers:
                worker = ctx.service_workers[0]
                break
            time.sleep(0.1)
        check("A: the extension loads and its worker runs", worker is not None)
        if worker is None:
            return
        ext_id = worker.url.split("/")[2]
        granted = worker.evaluate("async (o) => chrome.permissions.contains({ origins: [o] })", JEV_ORIGIN)
        check("A: a fresh install holds NO access to Jev's host", granted is False, f"contains={granted}")

        # Direct mode on (with a throwaway key), set the way the options page sets it.
        worker.evaluate(
            """async () => chrome.storage.local.set({ trackyOpts: {
                mode: 'direct', directKey: 'no-permission-test-key', directSource: 'zen-paid', disabledHosts: []
            } })"""
        )
        page = ctx.new_page()
        page.goto(page_url, wait_until="load")
        page.bring_to_front()
        time.sleep(0.5)
        check("A: the OS-level Alt+K gesture reached Chrome", press_shortcut())
        time.sleep(1.2)
        check("A: the panel is injected", page.evaluate("() => !!document.getElementById('tracky-root')"))
        boot = panel_status(page)
        check(
            "A: with no permission the panel asks for it by name",
            "allow access to opencode.ai" in boot,
            boot[:100],
        )
        out = run_panel_search(page, "hidden charges")
        check(
            "A: a search stops at the permission gate with the honest reason",
            "needs permission for opencode.ai" in out["status"] and "helper" not in out["status"].lower(),
            out["status"][:110],
        )
        check("A: no results are invented when it cannot run", out["hits"] == 0, f"{out['hits']} hit(s)")

        # The options page's own status line must name the same missing permission — the
        # two must never disagree about why direct mode cannot run.
        opts_page = ctx.new_page()
        opts_page.goto(f"chrome-extension://{ext_id}/options.html", wait_until="load")
        line = ""
        for _ in range(12):
            line = opts_page.evaluate("() => document.getElementById('htext').textContent").strip()
            if "allow access" in line:
                break
            time.sleep(0.4)
        check(
            "A: the options page names the missing permission too",
            line == "direct — allow access to opencode.ai in Connect",
            line[:90],
        )
        opts_page.close()
    finally:
        ctx.close()


def phase_b_granted(pw, profile: str, page_url: str, query: str, key: str) -> None:
    """The accepted state: paste the key in the real UI, test it, then search with the
    helper STOPPED — direct mode's entire reason to exist."""
    print("\nB. the granted build (host permission on the same code)")
    ext = granted_copy(tempfile.mkdtemp(prefix="tracky-direct-ext-"))
    ctx = launch(pw, profile, ext)
    console_lines: list[str] = []
    try:
        worker = None
        for _ in range(300):
            if ctx.service_workers:
                worker = ctx.service_workers[0]
                break
            time.sleep(0.1)
        if worker is None:
            check("B: the extension loads and its worker runs", False)
            return
        check("B: the extension loads and its worker runs", True)
        ext_id = worker.url.split("/")[2]
        granted = worker.evaluate("async (o) => chrome.permissions.contains({ origins: [o] })", JEV_ORIGIN)
        check("B: the same code now holds the Jev origin", granted is True)

        # --- the real options UI -------------------------------------------------
        opts = ctx.new_page()
        opts.on("console", lambda m: console_lines.append(m.text))
        opts.goto(f"chrome-extension://{ext_id}/options.html", wait_until="load")
        opts.wait_for_timeout(1200)
        check("B: a fresh install starts in helper mode", opts.evaluate("() => document.getElementById('mode-helper').checked") is True)
        check("B: the direct fields are hidden until direct is picked", opts.evaluate("() => document.getElementById('direct').hidden") is True)

        opts.check("#mode-direct")
        opts.wait_for_timeout(500)
        stored = worker.evaluate("() => chrome.storage.local.get('trackyOpts')")
        check("B: picking Direct saves the mode", (stored or {}).get("trackyOpts", {}).get("mode") == "direct", json.dumps((stored or {}).get("trackyOpts", {}))[:70])
        check("B: the direct panel appears", opts.evaluate("() => document.getElementById('direct').hidden") is False)
        htext = opts.evaluate("() => document.getElementById('htext').textContent")
        check("B: with no key yet the status line says exactly that", "paste your Jev key" in htext, htext[:90])
        check(
            "B: the helper's own source list is marked not-used",
            "not used in direct mode" in opts.evaluate("() => document.getElementById('source').textContent + document.getElementById('source-note').textContent"),
            opts.evaluate("() => document.getElementById('source-note').textContent")[:90],
        )

        routes = opts.evaluate("() => [...document.querySelectorAll('#dsource option')].map(o => o.value)")
        check("B: the route picker offers the two Jev routes", routes == ["zen-paid", "zen-free"], " · ".join(routes))

        # paste the key — typed into the real password field, never printed here
        opts.fill("#dkey", key)
        opts.dispatch_event("#dkey", "change")
        opts.wait_for_timeout(400)
        saved_key = worker.evaluate("async () => (await chrome.storage.local.get('trackyOpts')).trackyOpts.directKey")
        check("B: the pasted key is saved in chrome.storage.local", saved_key == key, f"{len(saved_key or '')} chars stored")
        check("B: the status line now reads 'no helper needed'", opts.evaluate("() => document.getElementById('htext').textContent").strip() == "direct — no helper needed")

        # one real call, from the real button
        opts.click("#dtest")
        opts.wait_for_timeout(500)
        note = ""
        for _ in range(50):
            note = opts.evaluate("() => document.getElementById('dtest-note').textContent")
            if note.startswith("✓") or note.startswith("✗"):
                break
            time.sleep(0.4)
        check("B: Test key makes one real call and reports it", note.startswith("✓") and "answered in" in note, note[:110])

        opts.reload(wait_until="load")
        opts.wait_for_timeout(1200)
        check("B: the mode and the key survive a reload", opts.evaluate("() => document.getElementById('mode-direct').checked") is True and len(opts.evaluate("() => document.getElementById('dkey').value")) == len(key))
        # Straight after a reload the status line must be the direct one: a stale
        # "helper … ready" line would be a lie about which mode is actually running.
        after = ""
        for _ in range(10):
            after = opts.evaluate("() => document.getElementById('htext').textContent").strip()
            if "direct" in after:
                break
            time.sleep(0.4)
        check("B: after a reload the status line is the direct one, not a stale helper line", after == "direct — no helper needed", after[:80])

        # --- no helper anywhere ---------------------------------------------------
        helper_was_up = helper_health() is not None
        stop_helper()
        check("B: the helper is STOPPED before the search (port 4199 closed)", helper_health() is None)

        page = ctx.new_page()
        page.on("console", lambda m: console_lines.append(m.text))
        page.goto(page_url, wait_until="load")
        page.bring_to_front()
        time.sleep(0.5)
        check("B: the OS-level Alt+K gesture reached Chrome", press_shortcut())
        time.sleep(1.2)
        page.evaluate("() => { const r = document.getElementById('tracky-root').shadowRoot; r.querySelector('input').focus(); }")
        check("B: the status line reports direct mode, ready", "direct" in panel_status(page) and "ready" in panel_status(page), panel_status(page)[:90])

        out = run_panel_search(page, query)
        if "rate-limited" in out["status"]:
            check(f"B: the real search answered (query “{query}”)", False, out["status"])
        check(
            f"B: a real search runs with the helper stopped (“{query}”)",
            "passages" in out["status"] and "match" in out["status"],
            out["status"][:110],
        )
        check("B: results came back", out["hits"] >= 1, f"{out['hits']} hit(s), {out['chips']} receipt chip(s)")
        check(
            "B: the sentences are painted on the page (CSS Custom Highlight)",
            out["highlights"]["all"] >= 1 and out["highlights"]["now"] >= 1,
            f"all={out['highlights']['all']} now={out['highlights']['now']}",
        )
        page_text = page.evaluate("() => document.body.innerText")
        check(
            "B: every hit is quoted from the page, not invented",
            all(s and s.split("…")[0][:40] in page_text for s in out["sentences"] if s) and bool(out["sentences"]),
            f"{len(out['sentences'])} sentence(s) checked against the page",
        )

        # The chip pass is a SECOND real call (fired after the list lands). Prove direct
        # mode runs it, and that no reason outside the closed list can ever appear.
        reasons = opts.evaluate("() => globalThis.TrackyDirect.REASONS")
        chips: list[str] = []
        for _ in range(24):
            chips = page.evaluate(
                """() => { const r = document.getElementById('tracky-root').shadowRoot;
                    return [...r.querySelectorAll('.why')].filter(e => !e.hidden).map(e => e.textContent.trim()); }"""
            )
            if chips:
                break
            time.sleep(0.5)
        check(
            "B: why-chips are picked from the closed reason list (no invented reason)",
            all(c in reasons for c in chips),
            f"{len(chips)} chip(s): " + "; ".join(chips)[:80],
        )

        # --- the BLOCKED-vs-FAIL rule rides on the status, not on the wording ---------
        # A rejected key must cross the message channel as status 401, not only as a
        # sentence: the suites (and any future UI) decide from the status. Throwaway key,
        # restored immediately — the real one is never printed anywhere.
        opts.evaluate(
            """async (bad) => {
                const o = (await chrome.storage.local.get("trackyOpts")).trackyOpts;
                await chrome.storage.local.set({ trackyOpts: { ...o, directKey: bad } });
            }""",
            "not-a-real-key",
        )
        rejected = opts.evaluate(
            """async () => {
                const r = await chrome.runtime.sendMessage({ type: "tracky:search", query: "x", passages: [{ id: "p0", text: "A fee applies." }] });
                return { ok: r?.ok ?? null, status: r?.status ?? null, error: r?.error ?? "" };
            }"""
        )
        opts.evaluate(
            """async (good) => {
                const o = (await chrome.storage.local.get("trackyOpts")).trackyOpts;
                await chrome.storage.local.set({ trackyOpts: { ...o, directKey: good } });
            }""",
            key,
        )
        check(
            "B: a rejected key crosses the channel with its status (401), not just a sentence",
            rejected["ok"] is False and rejected["status"] == 401,
            f"ok={rejected['ok']} status={rejected['status']} · {rejected['error'][:60]}",
        )

        # No key at all: the honest failure is NO_KEY (400) — never a network story.
        opts.evaluate(
            """async () => {
                const o = (await chrome.storage.local.get("trackyOpts")).trackyOpts;
                await chrome.storage.local.set({ trackyOpts: { ...o, directKey: "" } });
            }"""
        )
        nokey = opts.evaluate(
            """async () => {
                const r = await chrome.runtime.sendMessage({ type: "tracky:search", query: "x", passages: [{ id: "p0", text: "A fee applies." }] });
                return { ok: r?.ok ?? null, status: r?.status ?? null, error: r?.error ?? "" };
            }"""
        )
        opts.evaluate(
            """async (good) => {
                const o = (await chrome.storage.local.get("trackyOpts")).trackyOpts;
                await chrome.storage.local.set({ trackyOpts: { ...o, directKey: good } });
            }""",
            key,
        )
        check(
            "B: an empty key fails as NO_KEY (400) before any request",
            nokey["ok"] is False and nokey["status"] == 400 and "no key yet" in nokey["error"],
            f"ok={nokey['ok']} status={nokey['status']} · {nokey['error'][:60]}",
        )

        # The always-visible note: a declined permission prompt reverts the mode and hides
        # the Direct panel, so the reason has to live outside it (the bubble itself is
        # browser chrome — the harness cannot click it, so the mechanism is what is proven).
        shown = opts.evaluate(
            """() => {
                setNote("warn", "probe");
                const el = document.getElementById("mode-note");
                const out = { hidden: el.hidden, text: el.textContent, cls: el.className };
                el.hidden = true; // leave the page as it was for the screenshots
                return out;
            }"""
        )
        check(
            "B: the visible note works outside the Direct panel (what a declined prompt shows)",
            shown["hidden"] is False and shown["text"] == "probe" and "warn" in shown["cls"],
            f"hidden={shown['hidden']} class={shown['cls']}",
        )

        # --- the key must be nowhere it should not be ------------------------------
        check("B: the key is not in the page text", key not in page_text)
        check("B: the key is not in the panel", key not in out["text"])
        check("B: the key is not on the options page", key not in opts.evaluate("() => document.body.innerText"))
        check("B: the key is not in any console line", not any(key in line for line in console_lines), f"{len(console_lines)} console line(s) checked")
        dump = worker.evaluate("() => chrome.storage.local.get(null)")
        check(
            "B: storage holds the key once, in the options object only",
            json.dumps(dump).count(key) == 1 and dump.get("trackyOpts", {}).get("directKey") == key,
            f"{json.dumps(dump).count(key)} occurrence(s) across {len(dump)} storage key(s)",
        )

        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / "tracky-direct.png"))
        opts.screenshot(path=str(OUT / "tracky-direct-options.png"))
    finally:
        ctx.close()
        if helper_was_up:  # leave the machine as we found it — never start a helper
            check("B: the helper is running again for the rest of the battery", start_helper())
        else:
            print("  SKIP   B: the helper was down before this run — left down on purpose")


def main() -> int:
    key = read_key()
    query = os.environ.get("TRACKY_DIRECT_QUERY", "hidden charges")
    url = os.environ.get("TRACKY_DIRECT_URL", "")

    httpd = None
    if not url:
        handler = partial(SimpleHTTPRequestHandler, directory=str(FIXTURES))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}/tos.html"

    print(f"Tracky direct mode — live smoke ({time.strftime('%d %b %Y %H:%M')})")
    print(f"page: {url}   query: “{query}”   key: {len(key)} chars from server/.env (never printed)")
    try:
        with sync_playwright() as pw:
            with tempfile.TemporaryDirectory(prefix="tracky-direct-a-") as profile_a:
                phase_a_shipped(pw, profile_a, url)
            with tempfile.TemporaryDirectory(prefix="tracky-direct-b-") as profile_b:
                phase_b_granted(pw, profile_b, url, query, key)
    finally:
        if httpd:
            httpd.shutdown()

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    blocked = [c for c in CHECKS if not c[1] and c[2] == "blocked by the model route"]
    failed = [c for c in CHECKS if not c[1] and c[2] != "blocked by the model route"]
    print(f"\n{passed}/{len(CHECKS)} checks passed" + (" — ALL GOOD" if not failed and not blocked else ""))
    for name, _, detail in blocked:
        print(f"  BLOCKED: {name} — {detail}")
    for name, _, detail in failed:
        print(f"  FAILED: {name} — {detail}")
    if failed:
        return 1
    return 2 if blocked else 0


if __name__ == "__main__":
    sys.exit(main())
