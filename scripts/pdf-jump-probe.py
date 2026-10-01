#!/usr/bin/env python3
"""Model-free round-trip probe: every passage a PDF collects must be jumpable.

Why this exists: the reader (pdf.html) once loaded content.js WITHOUT shared.js,
so globalThis.TrackyShared was undefined there and rangeForHit resolved every
hit to -1 — each jump died as "could not locate that sentence — the page may
have changed" while the results themselves looked fine. Web pages never saw it
(background.js injects shared.js there), so it read as "huge PDFs only".

What it proves, with zero model calls:
  P1  TrackyShared.resolveOffset is a function inside the real reader
      (the regression: panel present + Shared missing = every jump fails).
  P2  collector counters agree (byId.size == blocks, section counts sum).
  P3  (node, real code) for EVERY block, EVERY sentence from the real
      server/sentences.mjs splitter: the slice invariant holds AND the real
      shared.js resolveOffset returns the exact offset.
  P4  (node) every non-synthetic segment maps inside its text node
      (end-start+base <= node.data.length, connected) — so rangeFor's
      setStart/setEnd can never throw or collapse for these offsets.

Run (repo-relative, no machine paths — every temp file is per-run isolated):
  xvfb-run -a -s "-screen 0 1400x1000x24" python3 scripts/pdf-jump-probe.py <file.pdf>

Scale notes: verify-all.sh runs this on extension/tests/sample.pdf (15 pages,
39 blocks) and twocol.pdf (16 pages, 55 blocks). A 167-page thesis (330 blocks,
1875 sentences, all resolving) was proven ad hoc and recorded in
docs/judge-report.md — it lives outside the repo so the battery cannot pin it.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
TMP_NAME = f"__jump-probe-{os.getpid()}-{secrets.token_hex(4)}.pdf"

NODE_VERIFY = """import { readFileSync } from 'node:fs';
const dump = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = process.argv[3];
import { pathToFileURL } from 'node:url';
const { splitSentences } = await import(pathToFileURL(`${root}/server/sentences.mjs`).href);
await import(pathToFileURL(`${root}/extension/shared.js`).href);
const { resolveOffset } = globalThis.TrackyShared;
let sents = 0;
const sliceFails = [], resolveFails = [], segFails = [];
for (const b of dump.blocks) {
  for (const s of splitSentences(b.text)) {
    sents++;
    if (b.text.slice(s.start, s.start + s.text.length) !== s.text) sliceFails.push([b.id, s.start]);
    else if (resolveOffset(b.text, s.start, s.text) !== s.start) resolveFails.push([b.id, s.start]);
  }
}
for (const m of dump.maps) {
  for (const g of m.segments) {
    if (g.synthetic) continue;
    if (!(g.start >= 0 && g.end > g.start && g.end <= m.text_len)) { segFails.push([m.id, 'bounds']); continue; }
    if (g.nodeLen >= 0 && (g.end - g.start) + (g.base ?? 0) > g.nodeLen) segFails.push([m.id, 'nodelen']);
    if (g.connected !== true) segFails.push([m.id, 'disconnected']);
  }
}
if (!dump.blocks.length || !sents) { console.log(JSON.stringify({ blocks: dump.blocks.length, sents, error: 'empty' })); process.exit(1); }
console.log(JSON.stringify({ blocks: dump.blocks.length, sents,
  sliceFails: sliceFails.length, resolveFails: resolveFails.length, segFails: segFails.length,
  ex: (sliceFails || resolveFails || segFails).slice(0, 3) }));
process.exit((sliceFails.length || resolveFails.length || segFails.length) ? 1 : 0);
"""


def find_chrome() -> str:
    cands = sorted(Path.home().glob(".cache/ms-playwright/chromium-*/chrome-linux64/chrome"))
    if not cands:
        sys.exit("probe needs the Playwright Chrome (npm i playwright + install) — none found")
    return str(cands[-1])


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    src = Path(sys.argv[1]).expanduser().resolve()
    if not src.is_file():
        sys.exit(f"not a file: {src}")
    tmp = EXT / "tests" / TMP_NAME
    shutil.copy(src, tmp)
    workdir = Path(tempfile.mkdtemp(prefix="tracky-jump-probe-"))
    failures: list[str] = []
    dump: dict = {}

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    try:
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(workdir / "profile"),
                executable_path=find_chrome(),
                headless=False,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
                      f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            )
            try:
                worker = None
                for _ in range(600):
                    if ctx.service_workers:
                        worker = ctx.service_workers[0]
                        break
                    time.sleep(0.1)
                if worker is None:
                    sys.exit("probe started Chrome but the extension service worker never registered")
                ext_id = worker.url.split("/")[2]
                page = ctx.new_page()
                try:
                    page.goto(f"chrome-extension://{ext_id}/pdf.html?src=chrome-extension://{ext_id}/tests/{TMP_NAME}&name=probe.pdf",
                              wait_until="load", timeout=60000)
                except Exception as e:
                    check("reader page loads", False, str(e)[:160])
                    return 1
                ready = False
                try:
                    for _ in range(600):
                        ready = page.evaluate("() => window.__trackyPdfReady === true")
                        if ready:
                            break
                        time.sleep(0.5)
                except Exception as e:
                    check("reader stays responsive while extracting", False, str(e)[:160])
                    return 1
                check("reader finishes extracting", ready)
                if not ready:
                    return 1
                dump = page.evaluate(
                    """() => {
                        const r = window.__trackyCollect();
                        const maps = [...r.byId.entries()].map(([id, e]) => ({
                          id, text_len: e.text.length,
                          segments: (e.segments ?? []).map(s => s.synthetic
                            ? { synthetic: true, start: s.start, end: s.end }
                            : { start: s.start, end: s.end, base: s.base ?? 0,
                                nodeLen: s.node?.data?.length ?? -1,
                                connected: !!s.node?.isConnected }),
                        }));
                        return {
                          blocks: r.blocks.map(b => ({ id: b.id, text: b.text })),
                          maps,
                          byIdSize: r.byId.size,
                          sectionSum: r.sections.reduce((a, s) => a + s.count, 0),
                          stats: r.stats,
                          shared: typeof globalThis.TrackyShared,
                          resolve: typeof globalThis.TrackyShared?.resolveOffset,
                          panel: !!document.getElementById('tracky-root'),
                        };
                    }""")
                check("P1 TrackyShared.resolveOffset is a function in the reader",
                      dump.get("resolve") == "function",
                      f"shared={dump.get('shared')} resolve={dump.get('resolve')} panel={dump.get('panel')}")
                check("P2 collector counters agree",
                      dump.get("byIdSize") == len(dump.get("blocks", [])) and
                      dump.get("sectionSum") == len(dump.get("blocks", [])),
                      f"byId {dump.get('byIdSize')} · sections {dump.get('sectionSum')} · blocks {len(dump.get('blocks', []))}")
                check("P0 the document yielded passages (a blank PDF proves nothing)",
                      len(dump.get("blocks", [])) > 0,
                      f"{len(dump.get('blocks', []))} blocks")
                st = dump.get("stats", {}) or {}
                print(f"  INFO  {st.get('pages')} pages · {len(dump.get('blocks', []))} passages · "
                      f"{st.get('chars')} chars · caps {st.get('blocks', 0) <= 600}")
            finally:
                ctx.close()

        # P3+P4 run in node against the REAL splitter + REAL shared.js, always
        # (even when P1 fails — they isolate the engine half from the wiring half).
        scratch = workdir / "blocks.json"
        scratch.write_text(json.dumps(dump))
        verify = workdir / "verify.mjs"
        verify.write_text(NODE_VERIFY)
        try:
            proc = subprocess.run(["node", str(verify), str(scratch), str(ROOT)],
                                  capture_output=True, text=True, timeout=300)
        except FileNotFoundError:
            check("P3+P4 node round-trip (real splitter + real shared.js)", False, "node not on PATH")
            proc = None
        out = proc.stdout.strip() if proc and proc.stdout else ""
        err = proc.stderr.strip()[:200] if proc and proc.stderr else ""
        try:
            rep = json.loads(out.splitlines()[-1]) if out else {}
        except Exception:
            rep = {}
        print(f"  INFO  node verify: {out.splitlines()[-1] if out else err or 'node did not run'}")
        if proc is not None and proc.returncode == 0 and rep:
            check(f"P3 every sentence resolves to its exact offset ({rep.get('sents')} sentences, {rep.get('blocks')} blocks)",
                  rep.get("resolveFails", 1) == 0 and rep.get("sliceFails", 1) == 0,
                  f"sliceFails={rep.get('sliceFails')} resolveFails={rep.get('resolveFails')}")
            check("P4 every segment maps inside its text node",
                  rep.get("segFails", 1) == 0, f"segFails={rep.get('segFails')} ex={rep.get('ex')}")
        else:
            node_err = proc.stderr.strip()[:200] if proc and proc.stderr else ""
            check("P3+P4 node round-trip (real splitter + real shared.js)", False,
                  rep.get("ex") if rep else node_err or "node did not run")
    finally:
        tmp.unlink(missing_ok=True)
        shutil.rmtree(workdir, ignore_errors=True)

    print(f"\n{'WOULD SHIP' if not failures else 'BLOCKED'} — {len(failures)} failing: {failures or 'none'}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
