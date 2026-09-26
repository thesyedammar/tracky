# Tracky — resume bullets + the defense drill (Phase 15.4 / 15.5)

## Resume bullets (pick 2–3; every number is real and reproducible)

**Tracky — Ctrl+F that searches by meaning (Chrome extension + Node helper)** · [repo]
- Built a meaning-based page search end-to-end: a Chrome MV3 extension, a loopback-only Node helper, and a model pipeline that may only **quote existing sentences** — every result is re-verified as an exact character slice, so the tool can fail loudly but can never fabricate text.
- Engineered for real pages: 107-passage article searched in **1.05 s**, 345-passage page collected in **31 ms**, cached repeats free; block caps, 45%-of-best ranking band and a 0.58 confidence gate keep weak guesses off the screen.
- Shipped **PDF mode** with bundled pdf.js — renders any PDF locally, extracts a text layer, and reuses the same panel contract so highlights land on the PDF's own text where the browser's Ctrl+F gives up.
- Verified like production, not like a demo: **100/100** unit tests, **46/46** real-browser checks on two targets, **18/18** PDF checks, **9/9** React-survival (zero DOM nodes touched inside a React root), a prompt-injection suite the bait cannot win, and a key-leak audit over the tree, the packaged zip and every commit.
- Kept privacy structural: page text goes page → local helper → the model route the user configured; the API key lives only in the helper's `.env` (600, gitignored) and never reaches the extension.

Short version (one line):
> Built Tracky, a Chrome extension that searches any web page (and PDFs) by meaning and quotes the exact sentences it found — verified with 100 unit tests, 46 live browser checks and an independent model judge; 107-passage pages searched in ~1 s.

## The defense drill — the five deep-dives, answered

**1. "How do you guarantee it doesn't hallucinate?"**
Three layers. (a) The prompt lets the model only *pick* a sentence index that already exists in the passage we sent. (b) The server ignores the model's own text field entirely — it takes the sentence from our own splitter by index, so a fabricated string has no path to the UI. (c) The ranking step re-checks that the sentence is an exact substring of the passage and throws if it is not. There are unit tests that feed it invented sentences, out-of-range indexes and nonsense scores: the search fails loudly instead of guessing. I can show the test file.

**2. "What happens on a page where the answer isn't there?"**
It shows nothing and says so — "no meaning matches". That is a feature: an honest empty beats a weak guess. The gate is a 0.58 confidence floor plus a band of everything within 45% of the best score. In testing, junk passages scored 0.02–0.08 and control passages 0.85–0.86, so the gate has a wide margin.

**3. "Why a local helper instead of calling the model from the extension?"**
Because a key in an extension is a key you have given away — anyone can unzip the package. The helper holds the key in a gitignored `.env` (chmod 600), binds to loopback only, and logs counts, never text. It also means the privacy story is checkable: `scripts/key-leak-check.mjs` scans the tree, the packaged zip and every commit, and reports zero leaks.

**4. "How do you know it works on real pages and not just your fixture?"**
The smoke harness drives a real Chromium under Xvfb with a real Alt+K gesture (that's what grants `activeTab`), and it runs against both a local fixture and a live Wikipedia article — 46 checks on each. Separately, 10 real pages were collected (107–345 passages) and a 15-page PDF was rendered and searched. The React-survival suite proves a highlight never mutates the host app's DOM: zero nodes added or removed inside a React root.

**5. "What would you do differently, or what's still weak?"**
Honest list: the free model route rate-limits, so I surface the real wait instead of pretending; a 1,000-passage page is ~13 serial model calls, so scope chips exist to shrink the search space; PDF canvases are lazy but never freed, so a 300-page document would sit on memory; and cross-tab search asks for the origins open right now, not a blanket permission — which means it works on the tabs you had open when you enabled it. Next: freeing off-screen PDF canvases, a local embedding model so the free route is not a dependency, and Firefox via the same contract.

## Demo script (for the video / live interview)

1. Open a long Wikipedia article. Say: "Ctrl+F for 'deposit' works, but I don't know the page uses the word 'deposit'."
2. Press **Alt+K**, type *"when do I get my deposit back?"*, Enter.
3. Point at the answer card: "That sentence is quoted, not written — and here's the receipt number."
4. Click the quote: the page scrolls and the sentence glows. "It never wraps your text in markup — it paints a range, so React apps don't even notice."
5. Click a scope chip: "107 passages became 6 — that's the speed and cost knob."
6. Open a PDF, click the icon: "Same panel, inside a PDF, where the browser's own find gives up."
7. Close with the honest limits — interviewers trust the limits more than the features.
