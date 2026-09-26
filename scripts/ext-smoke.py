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
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
FIXTURES = ROOT / "spikes" / "fixtures"
OUT = ROOT / "spikes" / "out"
HELPER = "http://127.0.0.1:4199/api/health"
FIXTURE_BASE = ""  # set by main() once the fixture server is up

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
        for _ in range(150):  # cold Chrome under Xvfb can take >5 s to register the worker
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

        # --- type a query, press Enter, and watch a real search happen ---
        query = os.environ.get("TRACKY_SMOKE_QUERY") or "hidden charges"
        real_site = bool(os.environ.get("TRACKY_SMOKE_URL"))
        min_passages = int(os.environ.get("TRACKY_SMOKE_MIN_PASSAGES") or ("100" if real_site else "8"))
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const i = h && h.shadowRoot && h.shadowRoot.querySelector('input');"
            " if (i) { i.focus(); i.select(); } }"
        )
        page.keyboard.type(query, delay=12)
        page.keyboard.press("Enter")
        text2 = ""
        for _ in range(600):  # up to ~60 s: big pages run several serial passes
            text2 = read_status(page)
            if "match" in text2 or "No meaning" in text2 or "failed" in text2 or "helper not running" in text2:
                break
            time.sleep(0.1)
        check("search ran against the live helper", "match" in text2, text2)
        seen = -1
        m = re.search(r"(\d+) passages", text2)
        if m:
            seen = int(m.group(1))
        check("helper saw the page's passages", seen >= min_passages, f"{seen} passages (min {min_passages})")
        hits = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const r = h && h.shadowRoot && h.shadowRoot.querySelector('#t-results');"
            " return r ? r.querySelectorAll('.hit').length : -1; }"
        )
        check("matches rendered in the panel", hits >= 1, f"{hits} hits")
        first_sentence = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const s = h && h.shadowRoot && h.shadowRoot.querySelector('.hit .sentence');"
            " return s ? s.textContent : ''; }"
        )
        check("first match quotes a real sentence", len(first_sentence) >= 20, first_sentence[:90])

        # --- Phase 7: answer card, hybrid exact-word group, why-chips ---
        card = page.evaluate(
            "() => { const h = document.getElementById('tracky-root'); const s = h && h.shadowRoot;"
            " if (!s) return null; const c = s.querySelector('.card'); if (!c) return null;"
            " return { title: c.querySelector('.card-title')?.textContent ?? '',"
            " lines: c.querySelectorAll('.card-line').length,"
            " chips: c.querySelectorAll('.chip').length,"
            " foot: c.querySelector('.card-foot')?.textContent ?? '' }; }"
        )
        check(
            "answer card quotes the page with receipt chips",
            bool(card) and card["lines"] >= 1 and card["chips"] == card["lines"] and "nothing invented" in card["foot"],
            str(card)[:140],
        )
        groups = page.evaluate(
            "() => { const h = document.getElementById('tracky-root'); const s = h && h.shadowRoot;"
            " if (!s) return null; return { groups: [...s.querySelectorAll('.group')].map((g) => g.textContent),"
            " exacts: s.querySelectorAll('.hit .tag').length,"
            " sentences: [...s.querySelectorAll('.hit .sentence')].map((e) => e.textContent) }; }"
        )
        sentences = groups["sentences"] if groups else []
        needle = query.lower()
        # Hybrid = literal + meaning merged. When the literal sentence is also the best
        # meaning match it is deduped (by design), so either the Exact-words group shows
        # or the query's sentence is present exactly once — and never twice.
        hybrid_ok = bool(groups) and (
            (any("Exact words" in g for g in groups["groups"]) and groups["exacts"] >= 1)
            or any(needle in s.lower() for s in sentences)
        )
        check(
            "hybrid: exact-word matches merge with meaning matches (deduped, no doubles)",
            hybrid_ok and len(sentences) == len(set(sentences)),
            f"groups={groups['groups'] if groups else None} exacts={groups['exacts'] if groups else None}",
        )
        why_text = ""
        for _ in range(120):  # chips ride a second helper pass — poll up to ~12 s
            why_text = page.evaluate(
                "() => { const h = document.getElementById('tracky-root'); const s = h && h.shadowRoot;"
                " if (!s) return ''; const w = [...s.querySelectorAll('.hit .why')].find((e) => !e.hidden && e.textContent);"
                " return w ? w.textContent : ''; }"
            )
            if why_text:
                break
            time.sleep(0.1)
        check("why-chips pick a reason from the helper's list", len(why_text) > 6, why_text)

        # --- Phase 7: click results -> page scrolls to + highlights the exact sentence ---
        scroll_before = page.evaluate("window.scrollY")
        room = page.evaluate("document.documentElement.scrollHeight - window.innerHeight")
        n_hits = page.evaluate(
            "() => document.getElementById('tracky-root').shadowRoot.querySelectorAll('.hit').length"
        )
        last_hit = 0
        for i in range(min(2, n_hits)):  # two hits: the first is the leading-whitespace paragraph
            last_hit = i
            sentence_i = page.evaluate(
                "() => document.getElementById('tracky-root').shadowRoot"
                f".querySelectorAll('.hit .sentence')[{i}].textContent"
            )
            page.evaluate(
                "() => document.getElementById('tracky-root').shadowRoot"
                f".querySelectorAll('.hit .jump')[{i}].click()"
            )
            page.wait_for_timeout(1100)
            hl_i = page.evaluate(
                "() => { try { const h = CSS.highlights.get('tracky-hl');"
                " return h ? [...h].map((r) => r.toString()).join(' | ') : ''; } catch { return ''; } }"
            )
            check(
                f"hit {i + 1}: highlighted text equals the quote exactly",
                hl_i == sentence_i and len(hl_i) > 20,  # no strip: leading-whitespace bugs must fail
                hl_i[:110],
            )
            inview = page.evaluate(
                "() => { try { const h = CSS.highlights.get('tracky-hl'); const r = h && [...h][0]; if (!r) return null;"
                " const b = r.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), window.innerHeight]; }"
                " catch { return null; } }"
            )
            check(
                f"hit {i + 1}: sentence is in view after the jump",
                bool(inview) and inview[0] >= -8 and inview[1] <= inview[2] + 8,
                str(inview),
            )
        scroll_after = page.evaluate("window.scrollY")
        print(f"  note  page scrolled {scroll_before} -> {scroll_after} (room {room})")
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const c = h && h.shadowRoot && h.shadowRoot.querySelector('.hit .copy'); if (c) c.click(); }"
        )
        page.wait_for_timeout(400)
        text3 = read_status(page)
        check("copying a quote gives feedback", "copied" in text3 or "copy blocked" in text3, text3)
        ranks = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " return [...h.shadowRoot.querySelectorAll('.hit .rank')].map((r) => r.textContent); }"
        )
        check("results carry 1..N rank numbers", ranks == [str(i + 1) for i in range(len(ranks))] and len(ranks) >= 1, str(ranks))
        # Enter on the focused copy button must copy — never jump the page
        scroll_pre = page.evaluate("window.scrollY")
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const c = h.shadowRoot.querySelector('.hit .copy'); if (c) c.focus(); }"
        )
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        text4 = read_status(page)
        scroll_post = page.evaluate("window.scrollY")
        check(
            "Enter on the copy button copies instead of jumping",
            "copied" in text4 and abs(scroll_post - scroll_pre) <= 8,
            f"{text4!r} scroll {scroll_pre} -> {scroll_post}",
        )

        shot = OUT / "tracky-panel.png"
        page.screenshot(path=str(shot))
        check("screenshot saved", shot.exists(), str(shot))

        # --- honest failure states ---
        page.evaluate(
            "() => { try { const h = CSS.highlights.get('tracky-hl'); const r = h && [...h][0]; if (!r) return;"
            " const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;"
            " const block = node && node.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption, pre');"
            " if (block) block.remove(); } catch {} }"
        )
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            f" const hit = h && h.shadowRoot && h.shadowRoot.querySelectorAll('.hit .jump')[{last_hit}]; if (hit) hit.click(); }}"
        )
        page.wait_for_timeout(400)
        text5 = read_status(page)
        check("a removed sentence gets the honest message", "no longer on this page" in text5, text5)

        # --- Phase 7: export + scope chips ---
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const b = h && h.shadowRoot && h.shadowRoot.querySelector('.export'); if (b) b.click(); }"
        )
        page.wait_for_timeout(400)
        text6 = read_status(page)
        check("export copies all matches as markdown", "markdown" in text6 or "copy blocked" in text6, text6)

        scopes = page.evaluate(
            "() => { const h = document.getElementById('tracky-root'); const s = h && h.shadowRoot;"
            " if (!s) return null; const el = s.querySelector('#t-scope'); if (!el || el.hidden) return null;"
            " return [...el.querySelectorAll('.scope-chip')].map((c) => c.textContent.trim()); }"
        )
        check("scope chips come from the page's headings", bool(scopes) and len(scopes) >= 2, str(scopes)[:140])
        if scopes:
            passages_before = seen  # captured from the first search's status line
            page.evaluate(
                "() => { const h = document.getElementById('tracky-root');"
                " const c = h.shadowRoot.querySelectorAll('.scope-chip')[1]; if (c) c.click(); }"
            )
            text7 = ""
            for _ in range(600):  # scoped re-search runs a real helper pass
                text7 = read_status(page)
                if "passages ·" in text7 and "· “" in text7:
                    break
                time.sleep(0.1)
            passages_after = page.evaluate(
                "() => { const m = document.getElementById('tracky-root').shadowRoot.querySelector('#t-status').textContent.match(/(\\d+) passages/);"
                " return m ? Number(m[1]) : -1; }"
            )
            check(
                "clicking a scope chip re-searches only that section",
                0 < passages_after < passages_before and "· “" in text7,
                f"{passages_before} -> {passages_after} · {text7[:90]}",
            )

        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const i = h.shadowRoot.querySelector('input'); i.focus(); i.select(); }"
        )
        page.keyboard.type("how do i file a tax return for my pet dragon", delay=6)
        page.keyboard.press("Enter")
        for _ in range(300):
            text6 = read_status(page)
            if "match" in text6 or "failed" in text6 or "not running" in text6:
                break
            time.sleep(0.1)
        empty = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const e = h && h.shadowRoot && h.shadowRoot.querySelector('.empty'); return e ? e.textContent : ''; }"
        )
        check("zero matches shows the honest empty state", "No meaning matches" in empty and "try rephrasing" in empty, empty[:110])

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

        # The deny-list matcher lives in shared.js and is loaded by the service worker —
        # unit-test it right there, where the injection gate actually runs it.
        hm = worker.evaluate(
            """() => ({
                exact: hostMatches('example.com', 'example.com'),
                sub: hostMatches('mail.example.com', 'example.com'),
                deep: hostMatches('a.b.example.com', 'example.com'),
                upper: hostMatches('MAIL.Example.COM', 'Example.com'),
                lookalike: hostMatches('notexample.com', 'example.com'),
                empty: hostMatches('example.com', ''),
                denied: hostDenied('mail.example.com', ['example.com']),
                allowed: hostDenied('mail.example.com', ['other.com'])
            })"""
        )
        check(
            "deny list matches the host and its subdomains (SW unit check)",
            hm["exact"] and hm["sub"] and hm["deep"] and hm["upper"] and hm["denied"]
            and not hm["lookalike"] and not hm["empty"] and not hm["allowed"],
            str(hm),
        )

        # End-to-end deny list: with this page's host listed, the live panel says it is off,
        # and a fresh page gets no injection at all (the service-worker gate). The fixture
        # host is listed too because the fresh page below is served from it.
        page_host = urlparse(page_url).hostname or "127.0.0.1"
        deny_js = json.dumps([page_host, "127.0.0.1"])
        worker.evaluate(
            f"() => chrome.storage.local.set({{ trackyOpts: {{ hijackCtrlF: true, countSearches: true, disabledHosts: {deny_js} }} }})"
        )
        page.wait_for_timeout(500)
        worker.evaluate(
            """async () => {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                await chrome.tabs.sendMessage(tab.id, { type: "tracky:open" });
            }"""
        )
        page.wait_for_timeout(400)
        denied_status = read_status(page)
        check(
            "deny list reaches the live panel (content-script mirror)",
            "off for this site" in denied_status,
            denied_status[:90],
        )

        denied_page = ctx.new_page()
        denied_page.goto(f"{FIXTURE_BASE}/tos.html", wait_until="load")
        denied_page.wait_for_timeout(400)
        press_shortcut("Car Rental Agreement")
        denied_page.wait_for_timeout(700)
        injected = denied_page.evaluate("() => !!document.getElementById('tracky-root')")
        badge_denied = ""
        for _ in range(20):
            badge_denied = worker.evaluate(
                """async () => {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    return chrome.action.getBadgeText({ tabId: tab.id });
                }"""
            )
            if badge_denied == "–":
                break
            time.sleep(0.1)
        check(
            "deny list blocks injection on a fresh page (SW gate)",
            (not injected) and badge_denied == "–",
            f"injected={injected} badge={badge_denied!r}",
        )
        denied_page.close()
        # Back to an empty deny list so the remaining checks behave normally.
        worker.evaluate(
            "() => chrome.storage.local.set({ trackyOpts: { hijackCtrlF: true, countSearches: true, disabledHosts: [] } })"
        )
        page.wait_for_timeout(300)

        # ---- Phase 9: live debounce, history, cache, rescan, keyboard, a11y, options ----
        # Reset the scope first: earlier checks left a section selected.
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const c = h.shadowRoot.querySelectorAll('.scope-chip')[0]; if (c) c.click(); }"
        )
        page.wait_for_timeout(600)

        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const i = h.shadowRoot.querySelector('input'); i.focus(); i.select(); }"
        )
        page.keyboard.type("security deposit", delay=12)  # NO Enter — the 700 ms debounce must search
        debounced_hits = 0
        for _ in range(250):  # debounce + a real helper pass
            debounced_hits = page.evaluate(
                "() => { const h = document.getElementById('tracky-root');"
                " const s = h && h.shadowRoot; return s ? s.querySelectorAll('.hit').length : 0; }"
            )
            if debounced_hits:
                break
            time.sleep(0.1)
        check("live search: typing alone finds matches (700 ms debounce)", debounced_hits >= 1, f"{debounced_hits} hits")

        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const i = h.shadowRoot.querySelector('input'); i.focus(); i.select(); }"
        )
        page.keyboard.type("cancellation", delay=8)
        page.keyboard.press("Enter")
        for _ in range(300):
            if "passages ·" in read_status(page):
                break
            time.sleep(0.1)

        # Empty the field → history chips appear; clicking one must hit the cache.
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const i = h.shadowRoot.querySelector('input'); i.focus(); i.select(); }"
        )
        page.keyboard.press("Backspace")
        page.wait_for_timeout(300)
        recents = page.evaluate(
            "() => { const h = document.getElementById('tracky-root'); const s = h && h.shadowRoot;"
            " const el = s && s.querySelector('#t-recent'); if (!el || el.hidden) return null;"
            " return [...el.querySelectorAll('.recent-chip')].map((c) => c.textContent); }"
        )
        check(
            "history chips appear while the field is empty",
            bool(recents) and any("security deposit" in r for r in recents),
            str(recents)[:130],
        )
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const c = [...h.shadowRoot.querySelectorAll('.recent-chip')].find((x) => x.textContent.includes('security deposit'));"
            " if (c) c.click(); }"
        )
        cached_text = ""
        for _ in range(200):
            cached_text = read_status(page)
            if "cached" in cached_text:
                break
            time.sleep(0.1)
        check("a repeat question is answered from cache (no helper call)", "cached" in cached_text, cached_text[:95])

        # Rescan forces a fresh pass over a possibly-changed page.
        page.evaluate("() => document.getElementById('tracky-root').shadowRoot.querySelector('#t-rescan').click()")
        rescanned = ""
        for _ in range(300):
            rescanned = read_status(page)
            if "ms" in rescanned and "cached" not in rescanned:
                break
            time.sleep(0.1)
        check("rescan button forces a fresh pass", "ms" in rescanned and "cached" not in rescanned, rescanned[:95])

        # ArrowDown from the input moves focus into the result list.
        page.evaluate(
            "() => { const h = document.getElementById('tracky-root'); h.shadowRoot.querySelector('input').focus(); }"
        )
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(200)
        focus_cls = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const a = h && h.shadowRoot && h.shadowRoot.activeElement; return a ? a.className : ''; }"
        )
        check("ArrowDown moves focus into the result list", "jump" in (focus_cls or ""), focus_cls)

        # Ctrl+F: the key must be delivered to the RENDERER, which is where our handler
        # lives. xdotool cannot do that here — proven by spikes/ctrlf-debug.py: in this
        # Xvfb session a plain xdotool key never reaches the page (only browser-level
        # shortcuts like Alt+K do), while CDP delivers exactly what Chrome hands the
        # renderer on a real Ctrl+F. The panel is already injected at this point
        # (second Alt+K above), which is the precondition for the hijack.
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.keyboard.press("Control+f")
        try:
            page.wait_for_function(WAIT_VISIBLE, timeout=6000)
            ctrl_f_open = True
        except Exception:
            ctrl_f_open = False
        check("Ctrl+F opens Tracky (hijack option, default on)", ctrl_f_open)

        # Reduced motion: the pulsing dot must stop animating.
        page.emulate_media(reduced_motion="reduce")
        page.wait_for_timeout(200)
        anim = page.evaluate(
            "() => { const h = document.getElementById('tracky-root');"
            " const d = h && h.shadowRoot && h.shadowRoot.querySelector('#t-dot');"
            " return d ? getComputedStyle(d).animationName : 'missing'; }"
        )
        check("prefers-reduced-motion stops the pulse", anim == "none", str(anim))
        page.emulate_media(reduced_motion="no-preference")

        # The options page is a real page — open it and read it.
        opts_url = worker.evaluate("() => chrome.runtime.getURL('options.html')")
        op = ctx.new_page()
        op.goto(opts_url, wait_until="load")
        op.wait_for_timeout(400)
        opts_title = op.evaluate("() => document.querySelector('h1')?.textContent ?? ''")
        helper_line = ""
        for _ in range(60):  # the options page pings the helper itself
            helper_line = op.evaluate("() => document.getElementById('htext')?.textContent ?? ''")
            if "ready" in helper_line or "not running" in helper_line:
                break
            time.sleep(0.1)
        opts_widgets = op.evaluate(
            "() => ({ hijack: !!document.getElementById('hijack'), hosts: !!document.getElementById('hosts'), reset: !!document.getElementById('reset') })"
        )
        check(
            "options page loads and reports the helper",
            "Tracky options" in opts_title and "ready" in helper_line and all(opts_widgets.values()),
            f"{opts_title.strip()[:40]} · {helper_line[:50]}",
        )
        op.close()

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
        title_tip = worker.evaluate(
            """async () => {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                return chrome.action.getTitle({ tabId: tab.id });
            }"""
        )
        check("unsupported page tooltip explains why", "can't read" in (title_tip or ""), title_tip)
        check("no panel injected on file://", page.evaluate("!document.getElementById('tracky-root')"))
    finally:
        ctx.close()


def main() -> int:
    global FIXTURE_BASE
    OUT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="tracky-profile-"))
    httpd, port = serve_fixtures()
    FIXTURE_BASE = f"http://127.0.0.1:{port}"
    page_url = os.environ.get("TRACKY_SMOKE_URL") or f"http://127.0.0.1:{port}/tos.html"
    try:
        with sync_playwright() as pw:
            run_checks(pw, profile, page_url)
    finally:
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    total = len(CHECKS)
    # A rate-limited model route is not a product failure: those checks never got a
    # chance to run. Report them separately (exit 2) so a red run is never confused
    # with a broken build.
    blocked = [c for c in CHECKS if not c[1] and "rate-limited" in c[2]]
    real_failures = [c for c in CHECKS if not c[1] and "rate-limited" not in c[2]]
    print(json.dumps({"checks": total, "passed": passed, "results": CHECKS}, indent=2))
    if blocked:
        print(f"\n{len(blocked)} check(s) blocked by the model route (rate-limited), not counted as failures:")
        for name, _, detail in blocked:
            print(f"  · {name}")
    if real_failures:
        print(f"\nFAILURES PRESENT — {passed}/{total} passed, {len(real_failures)} real failure(s)")
        return 1
    if blocked:
        print(f"\nBLOCKED — {passed}/{total} passed, {len(blocked)} blocked by the model route (re-run when the window opens)")
        return 2
    print(f"\nALL CHECKS PASSED — {passed}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
